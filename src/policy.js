// 服务策略：所有期限与年龄分级集中在此，README 的期限表与这里保持一致。
//
// 设计原则：
//  - 每个等待状态都有明确期限，到期自动落定（失效或关闭），不出现永久挂起；
//  - 年龄段决定能力上限，位置分享永远是独立同意项，不随加友默认开放；
//  - 撤销后允许一个很短的只读缓存失效窗口（24h），但消息/位置立即切断。

export const DEADLINES = Object.freeze({
  // 一次相识
  INTRO_PROOF_SCHOOL_TTL_HOURS: 24 * 7, // 学校证明：7 天，仅可兑换一次
  INTRO_PROOF_F2F_TTL_MINUTES: 10,      // 面对面短码：10 分钟，仅可兑换一次

  // 加友主流程
  FRIEND_REQUEST_TTL_DAYS: 7,           // 请求 7 天内未处理自动失效
  GUARDIAN_CONSENT_TTL_DAYS: 7,         // 儿童确认后，监护人 7 天内未同意则回退
  DEVICE_REBIND_TTL_DAYS: 3,            // 设备换绑：3 天确认期，关系挂起但不删除

  // 撤销
  CACHE_EXPIRY_HOURS: 24,               // 承诺：各方只读副本 24h 内失效
  LOCATION_SESSION_DEFAULT_HOURS: 1,    // 单次位置会话最长 1 小时，到时自动结束

  // 连续路径
  GUARDIANSHIP_GRACE_DAYS: 30,          // 监护权变更：老联系人 30 天只读宽限
  MIGRATION_TTL_DAYS: 14,               // 账号迁移窗口 14 天
  BRAND_EXIT_SUSPEND_DAYS: 90,          // 退出品牌 90 天迁移豁免期，之后自动撤销挂起关系
  EMERGENCY_REVIEW_DAYS: 90,            // 紧急联系人每 90 天复核一次
  EMERGENCY_CONTACT_LIMIT: 3,           // 每儿童最多 3 个预设紧急联系人

  // 证据封存（安全投诉专用，不与业务缓存同生命周期）
  EVIDENCE_RETENTION_DAYS: 365,
});

// 年龄分段（含下界，按周岁）。能力矩阵是"上限"：监护人还可以逐条收窄。
// 四种能力在不同年龄段分别开放：
//   <8            : 文字（默认仅家长代写/代读视角，由本方 UI 负责）
//   8–11          : +语音
//   12–15         : +群组（建群；低龄段只能被邀请进班级群）
//   16+           : +位置资格（真正分享仍需逐次独立同意 + 限时会话）
// 低龄位置需求走"紧急联系人"例外：监护人预设、绕过矩阵、每 90 天复核。
const AGE_BANDS = Object.freeze([
  { min: 0, caps: ["TEXT"] },
  { min: 8, caps: ["TEXT", "VOICE"] },
  { min: 12, caps: ["TEXT", "VOICE", "GROUP"] },
  { min: 16, caps: ["TEXT", "VOICE", "GROUP", "LOCATION_ELIGIBLE"] },
]);

export function ageBand(ageYears) {
  let band = AGE_BANDS[0];
  for (const candidate of AGE_BANDS) {
    if (ageYears >= candidate.min) band = candidate;
  }
  return band;
}

// 判断一段关系中某项能力是否在年龄上限内。
// 注意：LOCATION 通过此函数只说明"年龄允许申请"，真正开放还需独立位置同意。
export function capabilityAllowedByAge(capability, ageA, ageB) {
  if (capability === "LOCATION") {
    // 位置：低龄段不允许；即使允许，也必须再走一次独立同意。
    return ageBand(ageA).caps.includes("LOCATION_ELIGIBLE") &&
           ageBand(ageB).caps.includes("LOCATION_ELIGIBLE");
  }
  // 双方取交集，按年龄较小一方开放（就低不就高）。
  return ageBand(Math.min(ageA, ageB)).caps.includes(capability);
}

// 关系内一次能力开放的完整判定：年龄矩阵 AND 监护人逐条授权 AND 双方生效。
export function effectiveCapabilities(relationship, ageOf) {
  const result = new Set();
  if (!relationship || relationship.status !== "ACTIVE") return result;
  const ageA = ageOf(relationship.child_a);
  const ageB = ageOf(relationship.child_b);
  for (const cap of ["TEXT", "VOICE", "GROUP"]) {
    if (capabilityAllowedByAge(cap, ageA, ageB) && relationship.grants.has(cap)) {
      result.add(cap);
    }
  }
  if (relationship.grants.has("LOCATION") &&
      capabilityAllowedByAge("LOCATION", ageA, ageB)) {
    result.add("LOCATION");
  }
  return result;
}
