# -*- coding: utf-8 -*-
"""
Rotation 摊销离线模型
====================
基于 8 轮 controlled replay 实测数据（reports/_staged-epoch-rotation-20261007），
建模 rotation 轮（T8）缓存断裂成本的摊销过程，预测 10 轮实验的结果。

定价（与 demo-client.ts L1222-1224 一致，deepseek-chat）：
  miss   = $0.14  / 1M tokens
  hit    = $0.014 / 1M tokens
  output = $0.28  / 1M tokens

模型假设（由源码逻辑推导，待 10 轮实验验证）：
  A1. T1-T7：无压缩，代理输入=直连（实测已证）。
  A2. T8：rotation 轮（stablePrefixTurns 传入 6 ≥ rotationAfterRounds）。
  A3. T9 起 stablePrefixTurns 重置为 0（前缀已变化），T9 传入 0、T10 传入 1，
      均 < 6 → 不再有压缩（clear-middle 被稳定前缀保护挡住）。
  A4. T9/T10 代理输入 = T8 压缩后提示 + 上轮 assistant + 新 user。
  A5. Provider 前缀缓存：hit ≈ 上一轮提示长度（64 块取整），miss = 新增内容。
  A6. 直连输出略长于代理输出（实测 T4-T8 平均差 ~6%，保守取代理输出 = 直连 × 0.95）。
"""
import json

# ---------------- 实测数据（8 轮报告） ----------------
# (turn, d_in, d_hit, d_miss, d_out, p_in, p_hit, p_miss, p_out)
ACTUAL = [
    (1,  140,    0,  140,  302,  140,    0,  140,  301),
    (2,  555,  384,  171,  587,  555,  384,  171,  606),
    (3, 1316, 1024,  292,  983, 1316, 1152,  164,  900),
    (4, 2394, 2176,  218,  979, 2394, 2176,  218,  754),
    (5, 3518, 3328,  190, 1338, 3518, 3328,  190, 1223),
    (6, 4946, 4736,  210, 1537, 4946, 4736,  210, 1524),
    (7, 6678, 6400,  278,  909, 6678, 6528,  150,  777),
    (8, 7704, 7552,  152, 1455, 4974,  384, 4590, 1314),
]

P_MISS, P_HIT, P_OUT = 0.14e-6, 0.014e-6, 0.28e-6


def cost(hit, miss, out):
    return hit * P_HIT + miss * P_MISS + out * P_OUT


def block64(n):
    """DeepSeek 前缀缓存按 64-token 块命中"""
    return (n // 64) * 64


# ---------------- 校验：复现 8 轮报告成本 ----------------
d_cost = sum(cost(h, m, o) for _, di, h, m, o, *_ in
             [(t, *r) for t, *r in [(r[0], r[1], r[3], r[4], r[4]) for r in ACTUAL]])
d_cost = sum(cost(r[2], r[3], r[4]) for r in ACTUAL)
p_cost = sum(cost(r[6], r[7], r[8]) for r in ACTUAL)
print("== 8 轮实测成本复现 ==")
print(f"直连: ${d_cost:.4f}  (报告 0.0029)")
print(f"代理: ${p_cost:.4f}  (报告 0.0031)")
print(f"赤字(代理-直连): ${p_cost - d_cost:+.4f}")

# ---------------- 外推第 9-10 轮 ----------------
def project(u9, u10, d_out9, d_out10, proxy_out_ratio=0.95):
    """返回 T9/T10 两轮 (direct, proxy) 的预测成本"""
    d_in9 = 7704 + 1455 + u9          # T8 助手 + T9 user
    d_in10 = d_in9 + d_out9 + u10
    p_in9 = 4974 + 1314 + u9          # 压缩后提示 + T8 助手(代理版) + T9 user
    p_in9 = 4974 + int(1314 * proxy_out_ratio / 0.95 * 0.95) + u9  # 1314 已是代理实测
    p_in10 = p_in9 + int(d_out9 * proxy_out_ratio) + u10
    rows = []
    # T9
    d_hit9, d_miss9 = block64(7704), d_in9 - block64(7704)
    p_hit9, p_miss9 = block64(4974), p_in9 - block64(4974)
    rows.append((9, d_in9, d_hit9, d_miss9, d_out9, p_in9, p_hit9, p_miss9,
                 int(d_out9 * proxy_out_ratio)))
    # T10
    d_hit10, d_miss10 = block64(d_in9), d_in10 - block64(d_in9)
    p_hit10, p_miss10 = block64(p_in9), p_in10 - block64(p_in9)
    rows.append((10, d_in10, d_hit10, d_miss10, d_out10, p_in10, p_hit10, p_miss10,
                 int(d_out10 * proxy_out_ratio)))
    return rows


def full_run(rows):
    """8 轮实测 + 2 轮预测的累计成本"""
    d = sum(cost(r[2], r[3], r[4]) for r in ACTUAL) + sum(cost(r[2], r[3], r[4]) for r in rows)
    p = sum(cost(r[6], r[7], r[8]) for r in ACTUAL) + sum(cost(r[6], r[7], r[8]) for r in rows)
    return d, p


SCEN = [
    ("悲观（user=400, 输出偏长）", 400, 400, 1500, 1400),
    ("中心（user=300, 输出中位）", 300, 300, 1200, 1100),
    ("乐观（user=250, 输出偏短）", 250, 250, 950, 900),
]

print("\n== T9/T10 外推（三情景） ==")
results = {}
for name, u9, u10, o9, o10 in SCEN:
    rows = project(u9, u10, o9, o10)
    d10, p10 = full_run(rows)
    d_in_tot = sum(r[1] for r in ACTUAL) + rows[0][1] + rows[1][1]
    p_in_tot = sum(r[5] for r in ACTUAL) + rows[0][5] + rows[1][5]
    s9 = rows[0]
    s10 = rows[1]
    results[name] = rows
    print(f"\n--- {name} ---")
    print(f"T9 : 直连 {s9[1]} tok (cache {s9[2]/s9[1]*100:.0f}%) | "
          f"代理 {s9[5]} tok (cache {s9[6]/s9[5]*100:.0f}%)")
    print(f"T10: 直连 {s10[1]} tok (cache {s10[2]/s10[1]*100:.0f}%) | "
          f"代理 {s10[5]} tok (cache {s10[6]/s10[5]*100:.0f}%)")
    print(f"10 轮累计输入: 直连 {d_in_tot} vs 代理 {p_in_tot} "
          f"(省 {d_in_tot-p_in_tot}, {(d_in_tot-p_in_tot)/d_in_tot*100:.1f}%)")
    print(f"10 轮缓存折扣成本: 直连 ${d10:.4f} vs 代理 ${p10:.4f} "
          f"(代理 {'+' if p10>d10 else ''}${p10-d10:.4f})")

# ---------------- 盈亏平衡点 ----------------
print("\n== 盈亏平衡点估计 ==")
rows = results["中心（user=300, 输出中位）"]
d8, p8 = sum(cost(r[2], r[3], r[4]) for r in ACTUAL), sum(cost(r[6], r[7], r[8]) for r in ACTUAL)
cum = p8 - d8
print(f"T8 后累计赤字: ${cum:+.5f}")
t = 8
d_prior, p_prior = rows[0][1] - 300 - 1200, rows[0][5] - 300 - int(1200*0.95)  # 中心情景
while cum > 0 and t < 30:
    t += 1
    u, dout = 300, 1100
    d_prior_new = d_prior + dout + u
    p_prior_new = p_prior + int(dout * 0.95) + u
    sd = cost(block64(d_prior), d_prior_new - block64(d_prior), dout)
    sp = cost(block64(p_prior), p_prior_new - block64(p_prior), int(dout * 0.95))
    cum += sp - sd
    d_prior, p_prior = d_prior_new, p_prior_new
    print(f"T{t}: 单轮差异 ${sp-sd:+.5f} → 累计 ${cum:+.5f}")
print(f"\n结论: 缓存折扣口径下 rotation 成本约在 T{t} 摊销完毕（中心情景）")

# 额外: 无缓存折扣口径
print("\n== 无缓存折扣口径（仅 token 量） ==")
for name in results:
    rows = results[name]
    d_in = sum(r[1] for r in ACTUAL) + rows[0][1] + rows[1][1]
    p_in = sum(r[5] for r in ACTUAL) + rows[0][5] + rows[1][5]
    d_out = sum(r[4] for r in ACTUAL) + rows[0][4] + rows[1][4]
    p_out = sum(r[8] for r in ACTUAL) + rows[0][8] + rows[1][8]
    dc = d_in * P_MISS + d_out * P_OUT
    pc = p_in * P_MISS + p_out * P_OUT
    print(f"{name}: 直连 ${dc:.4f} vs 代理 ${pc:.4f} (省 ${dc-pc:.4f})")

# 导出预测 JSON（供实验后对比）
rows = results["中心（user=300, 输出中位）"]
pred = {
    "model": "rotation-amortization v1",
    "assumptions": {
        "A3": "T9/T10 无压缩（stablePrefixTurns=0/1 < 6）",
        "A4": "代理 T9 输入 = T8 压缩提示 + T8 助手 + 新 user",
        "A5": "Provider hit ≈ 上一轮提示 64 块取整",
        "A6": "代理输出 = 直连 × 0.95",
    },
    "t9": {"direct_in": rows[0][1], "proxy_in": rows[0][5],
           "direct_cache_pct": round(rows[0][2]/rows[0][1]*100, 1),
           "proxy_cache_pct": round(rows[0][6]/rows[0][5]*100, 1)},
    "t10": {"direct_in": rows[1][1], "proxy_in": rows[1][5],
            "direct_cache_pct": round(rows[1][2]/rows[1][1]*100, 1),
            "proxy_cache_pct": round(rows[1][6]/rows[1][5]*100, 1)},
    "predictions": {
        "second_rotation_before_t11": False,
        "break_even_turn": t,
        "cost_deficit_at_t10_usd": round(full_run(rows)[1] - full_run(rows)[0], 6),
    },
}
with open("predictions.json", "w", encoding="utf-8") as f:
    json.dump(pred, f, ensure_ascii=False, indent=2)
print("\npredictions.json 已写出")
