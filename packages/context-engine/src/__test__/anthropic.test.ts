// Anthropic 适配器测试：验证格式转换 + cache_control 断点插入
// 运行: pnpm --filter @context/engine exec tsx src/__test__/anthropic.test.ts

import { anthropicToMessages, messagesToAnthropic } from '../anthropic.js';
import type { AnthropicRequestBody, AnthropicContentBlock } from '../anthropic.js';
import type { Message } from '../types.js';

function hasCacheControl(block: AnthropicContentBlock): boolean {
  return block.cache_control?.type === 'ephemeral';
}

async function main() {
  let pass = 0;
  let fail = 0;
  const check = (cond: boolean, name: string) => {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name}`); }
  };

  // 测试 1：Anthropic → 内部 Message[]
  console.log('\n测试1: anthropicToMessages');
  const anthropicReq: AnthropicRequestBody = {
    model: 'claude-3-5-sonnet',
    max_tokens: 1024,
    system: 'You are a helpful assistant.',
    messages: [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
      { role: 'user', content: 'What is 2+2?' },
    ],
  };
  const internal = anthropicToMessages(anthropicReq);
  check(internal.length === 4, '消息数 = 4 (1 system + 3 对话)');
  check(internal[0]!.role === 'system', '第一条是 system');
  check(internal[0]!.content === 'You are a helpful assistant.', 'system 内容正确');
  check(internal[1]!.role === 'user', '第二条是 user');

  // 测试 2：system 为 blocks 数组
  console.log('\n测试2: system 为 blocks 数组');
  const reqWithBlocks: AnthropicRequestBody = {
    model: 'claude-3-5-sonnet',
    max_tokens: 1024,
    system: [
      { type: 'text', text: 'Rule 1: Be concise.' },
      { type: 'text', text: 'Rule 2: Be accurate.' },
    ],
    messages: [{ role: 'user', content: 'Hi' }],
  };
  const internal2 = anthropicToMessages(reqWithBlocks);
  check(
    typeof internal2[0]!.content === 'string' && internal2[0]!.content.includes('Rule 1') && internal2[0]!.content.includes('Rule 2'),
    'system blocks 合并为一条消息'
  );

  // 测试 3：messagesToAnthropic 断点插入
  console.log('\n测试3: messagesToAnthropic 断点插入');
  const messages: Message[] = [
    { role: 'system', content: 'You are a coding assistant.' },
    { role: 'user', content: 'Question 1' },
    { role: 'assistant', content: 'Answer 1' },
    { role: 'user', content: 'Question 2' },
    { role: 'assistant', content: 'Answer 2' },
    { role: 'user', content: 'Question 3' },
    { role: 'assistant', content: 'Answer 3' },
    { role: 'user', content: 'Question 4' },
    { role: 'assistant', content: 'Answer 4' },
    { role: 'user', content: 'Final question' },  // dynamic
  ];
  const result = messagesToAnthropic(messages);

  // system 应有 cache_control
  check(Array.isArray(result.system), 'system 是 blocks 数组');
  if (Array.isArray(result.system)) {
    const lastSysBlock = result.system[result.system.length - 1] as AnthropicContentBlock;
    check(hasCacheControl(lastSysBlock), 'system 末尾有 cache_control (断点1)');
  }

  // 统计 messages 中的 cache_control 数量
  let breakpointCount = 0;
  const breakpointRoles: string[] = [];
  for (const msg of result.messages) {
    if (Array.isArray(msg.content)) {
      const lastBlock = msg.content[msg.content.length - 1] as AnthropicContentBlock;
      if (hasCacheControl(lastBlock)) {
        breakpointCount++;
        breakpointRoles.push(`${msg.role}[${result.messages.indexOf(msg)}]`);
      }
    }
  }
  console.log(`  断点位置: ${breakpointRoles.join(', ')}`);
  check(breakpointCount <= 3, `messages 中断点数 ≤ 3 (实际: ${breakpointCount})`);

  // 总断点数（含 system）≤ 4
  const totalBreakpoints = breakpointCount + (Array.isArray(result.system) ? 1 : 0);
  check(totalBreakpoints <= 4, `总断点数 ≤ 4 (实际: ${totalBreakpoints})`);
  check(totalBreakpoints >= 2, `至少 2 个断点 (实际: ${totalBreakpoints})`);

  // 测试 4：无 system 时不崩
  console.log('\n测试4: 无 system 消息');
  const noSystem: Message[] = [
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi' },
    { role: 'user', content: 'Bye' },
  ];
  const result4 = messagesToAnthropic(noSystem);
  check(result4.system === undefined, 'system 为 undefined');
  check(result4.messages.length === 3, 'messages 数量正确');

  // 测试 5：短对话不插多余断点
  console.log('\n测试5: 短对话');
  const short: Message[] = [
    { role: 'system', content: 'System prompt' },
    { role: 'user', content: 'Hi' },
  ];
  const result5 = messagesToAnthropic(short);
  check(Array.isArray(result5.system), 'system 是 blocks');
  if (Array.isArray(result5.system)) {
    check(hasCacheControl(result5.system[0]! as AnthropicContentBlock), 'system 有断点');
  }

  // 汇总
  console.log(`\n--- 汇总 ---`);
  console.log(`通过: ${pass}, 失败: ${fail}`);
  console.log(`结果: ${fail === 0 ? 'PASS ✓' : 'FAIL ✗'}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('Test error:', e);
  process.exit(1);
});
