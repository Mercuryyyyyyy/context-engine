// 进阶可逆压缩测试：验证 P2 新增的 5 种压缩手法
// 运行: pnpm --filter @context/engine exec tsx src/__test__/reversible-advanced.test.ts

import { reversibleCompress } from '../compress/reversible.js';

async function main() {
  let pass = 0;
  let fail = 0;
  const check = (cond: boolean, name: string) => {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name}`); }
  };

  // 测试 1：注释折叠
  console.log('\n=== 测试1: 注释折叠 ===');
  const codeWithComments = `function foo() {
  // This is line 1 of a very long comment
  // that spans multiple lines
  // and should be folded
  // because it's too verbose
  // line 5
  // line 6
  return 42;
}`;
  const result1 = reversibleCompress(codeWithComments, { enableAdvanced: true });
  console.log(`  strategies: ${result1.strategies.join(', ')}`);
  console.log(`  saved: ${result1.saved} chars`);
  check(result1.strategies.includes('fold-comments'), '命中 fold-comments');
  check(result1.compressed.includes('<folded:'), '注释被折叠');
  check(result1.saved > 0, '节省了字符');

  // 测试 2：JSON 折叠
  console.log('\n=== 测试2: JSON 折叠 ===');
  const codeWithJson = `const config = ${JSON.stringify({
    database: { host: 'localhost', port: 5432, name: 'mydb', user: 'admin', password: 'secret' },
    cache: { driver: 'redis', host: 'localhost', port: 6379, ttl: 3600 },
    logging: { level: 'debug', file: '/var/log/app.log', maxsize: '100MB' }
  })};`;
  const result2 = reversibleCompress(codeWithJson, { enableAdvanced: true });
  console.log(`  strategies: ${result2.strategies.join(', ')}`);
  console.log(`  saved: ${result2.saved} chars`);
  check(result2.strategies.includes('fold-json'), '命中 fold-json');
  check(result2.compressed.length < codeWithJson.length, 'JSON 被压缩');

  // 测试 3：代码块折叠
  console.log('\n=== 测试3: 代码块折叠 ===');
  const longFunction = `export function processData(input) {
  const result = [];
  for (let i = 0; i < input.length; i++) {
    const item = input[i];
    const processed = item.value * 2 + 1;
    const filtered = processed > 10;
    const formatted = { id: item.id, value: processed, valid: filtered };
    result.push(formatted);
    if (result.length % 100 === 0) {
      console.log('Processed', result.length, 'items');
    }
  }
  return result;
}`;
  const result3 = reversibleCompress(longFunction, { enableAdvanced: true });
  console.log(`  strategies: ${result3.strategies.join(', ')}`);
  console.log(`  saved: ${result3.saved} chars`);
  check(result3.strategies.includes('fold-code'), '命中 fold-code');
  check(result3.compressed.includes('<folded:'), '代码块被折叠');
  check(result3.compressed.includes('processData'), '函数签名保留');

  // 测试 4：URL 折叠
  console.log('\n=== 测试4: URL 折叠 ===');
  const codeWithUrl = `const apiUrl = 'https://api.example.com/v1/users/12345/profile/details?include=settings&fields=name,email,phone,address,preferences,history,metadata,activity_log,sessions,devices,security,notifications,privacy,consent,permissions,roles,groups,teams,organizations,projects,tasks,comments,reactions,attachments,files,documents,notes,tags,labels,categories,collections,folders,workspaces,dashboards,reports,analytics,insights,metrics,kpis,goals,objectives,milestones,timelines,schedules,events,meetings,calls,messages,channels,conversations,threads,replies,forwards,attachments,links,bookmarks,favorites,likes,shares,follows,subscribers,members,contacts,connections,relationships,networks,communities,groups,forums,posts,articles,blogs,vlogs,podcasts,webinars,courses,lessons,tutorials,guides,docs,help,support,faq,terms,privacy,cookies,policies,guidelines,rules,regulations,compliance,security,privacy,trust,safety,abuse,report,block,mute,ignore,hide,delete,archive,restore,export,import,backup,restore,sync,migrate,transfer,convert,transform,translate,transliterate,transcribe,transmit,broadcast,stream,cast,record,capture,screenshot,download,upload,share,publish,post,send,receive,get,put,post,delete,patch,options,head,connect,disconnect,reconnect,ping,trace,route,dns,dhcp,ip,mac,ssid,wifi,bluetooth,nfc,usb,hdmi,dp,vga,dvi,ethernet,fiber,coaxial,twisted,wireless,cellular,5g,4g,lte,3g,2g,gsm,cdma,tdma,fdma,ofdma,mimo,miso,simo,siso,massive,beamforming,multiplexing,duplexing,frequency,wavelength,amplitude,phase,modulation,demodulation,encoding,decoding,compression,decompression,encryption,decryption,hashing,signing,verifying,authenticating,authorizing,auditing,logging,monitoring,alerting,notifying,reporting,dashboarding,visualizing,charting,graphing,plotting,mapping,geocoding,routing,directions,navigation,tracking,tracing,following,watching,observing,sensing,detecting,measuring,quantifying,qualifying,classifying,categorizing,tagging,labeling,grouping,clustering,segmenting,partitioning,dividing,merging,joining,combining,aggregating,summarizing,reporting,dashboarding';
  fetch(apiUrl);`;
  const result4 = reversibleCompress(codeWithUrl, { enableAdvanced: true });
  console.log(`  strategies: ${result4.strategies.join(', ')}`);
  console.log(`  saved: ${result4.saved} chars`);
  check(result4.strategies.includes('fold-urls'), '命中 fold-urls');
  check(result4.compressed.includes('<url:'), 'URL 被折叠');

  // 测试 5：字典去重
  console.log('\n=== 测试5: 字典去重 ===');
  const longLine = 'const veryLongVariableName = someFunction(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10);';
  const codeWithDup = `${longLine}\n// some other code\n${longLine}\n// more code\n${longLine}`;
  const result5 = reversibleCompress(codeWithDup, { enableAdvanced: true });
  console.log(`  strategies: ${result5.strategies.join(', ')}`);
  console.log(`  saved: ${result5.saved} chars`);
  check(result5.strategies.includes('dedup'), '命中 dedup');
  check(result5.compressed.includes('<dup:'), '重复行被替换');

  // 测试 6：综合效果对比（进阶开 vs 关）
  console.log('\n=== 测试6: 进阶 vs 基础对比 ===');
  const complexCode = `${codeWithComments}\n\n${codeWithJson}\n\n${longFunction}`;
  const basicResult = reversibleCompress(complexCode, { enableAdvanced: false });
  const advancedResult = reversibleCompress(complexCode, { enableAdvanced: true });
  console.log(`  原始: ${complexCode.length} chars`);
  console.log(`  基础: ${basicResult.compressed.length} chars (saved ${basicResult.saved})`);
  console.log(`  进阶: ${advancedResult.compressed.length} chars (saved ${advancedResult.saved})`);
  console.log(`  基础手法: ${basicResult.strategies.join(', ')}`);
  console.log(`  进阶手法: ${advancedResult.strategies.join(', ')}`);
  check(advancedResult.saved > basicResult.saved, '进阶压缩比基础多省');
  check(advancedResult.strategies.length > basicResult.strategies.length, '进阶命中更多手法');

  // 测试 7：短文本不误触
  console.log('\n=== 测试7: 短文本不误触 ===');
  const shortText = 'Hello world';
  const result7 = reversibleCompress(shortText);
  console.log(`  strategies: ${result7.strategies.join(', ') || '(none)'}`);
  check(result7.strategies.length === 0, '短文本不触发任何压缩');

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
