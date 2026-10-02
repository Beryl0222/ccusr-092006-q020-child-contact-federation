// 策略引擎：期限、年龄分级、理由文案。
//
// 所有期限集中在此，业务代码不得另写魔数；时间以毫秒为单位，
// 由服务注入时钟（默认 Date.now），便于测试与审计回放。

import { CAPABILITIES, REASON_CODES } from "./domain.js";

export const DURATIONS_MS = Object.freeze({
  // 一次性相识凭证有效期
  INTRO_FACE_TO_FACE_SHORT_CODE: 10 * 60 * 1000, // 现场短码 10 分钟
  INTRO_SCHOOL_ATTESTATION: 30 * 24 * 60 * 60 * 1000, // 学校证明 30 天
  INTRO_GUARDIAN_REFERENCE: 7 * 24 * 60 * 60 * 1000, // 监护人引荐 7 天

  FRIEND_REQUEST_TTL: 7 * 24 * 60 * 60 * 1000, // 加友请求 7 天内完成双向确认+双方同意
  PEER_CONFIRM_TTL: 7 * 24 * 60 * 60 * 1000, // 被请求方确认的剩余期限同上，统一口径
  CONSENT_TTL: 7 * 24 * 60 * 60 * 1000, // 监护同意窗口同请求期限

  DEVICE_REBIND_TTL: 15 * 24 * 60 * 60 * 1000, // 设备换绑 15 天内完成，逾期挂起关系
  GUARDIANSHIP_GRACE: 30 * 24 * 60 * 60 * 1000, // 监护权改变的连续处理宽限期 30 天
  MIGRATION_RECONSENT_WINDOW: 14 * 24 * 60 * 60 * 1000, // 账号迁移后重新确认 14 天
  BRAND_EXIT_WINDDOWN: 90 * 24 * 60 * 60 * 1000, // 品牌退出联盟过渡期 90 天

  EMERGENCY_CONTACT_TTL: 24 * 60 * 60 * 1000, // 紧急联系人例外最多 24 小时
  LOCATION_SESSION_TTL: 60 * 60 * 1000, // 单次位置分享会话最长 60 分钟
  LOCATION_SESSION_DEFAULT: 30 * 60 * 1000,

  CACHE_EXPIRY_AFTER_REVOCATION: 24 * 60 * 60 * 1000, // 撤销后各方缓存承诺失效时间
  CACHE_ACK_GRACE: 2 * 24 * 60 * 60 * 1000, // 缓存失效回执宽限（仍须在承诺时间内失效，回执可稍后）

  COMPLAINT_REVIEW_SLA: 7 * 24 * 60 * 60 * 1000, // 跨品牌申诉处理期限
  EVIDENCE_RETENTION: 180 * 24 * 60 * 60 * 1000, // 安全证据另行封存 180 天后销毁
});

// 年龄段（粗粒度；跨品牌只交换这个，不交换生日）。
// 能力对关系双方取交集：低龄一方决定上限。
// 位置永远是“单次限时会话”，不做持续权限；群组需要双方都达到门槛。
export const AGE_BANDS = Object.freeze({
  "0-7": Object.freeze([]),
  "8-11": Object.freeze(["TEXT"]),
  "12-15": Object.freeze(["TEXT", "VOICE", "LOCATION", "GROUP"]),
  "16-17": Object.freeze(["TEXT", "VOICE", "LOCATION", "GROUP"]),
});

export function capabilitiesForAgeBand(ageBand) {
  return AGE_BANDS[ageBand] ? [...AGE_BANDS[ageBand]] : [];
}

// 一段关系上实际开放的能力 = 双方年龄段允许集合的交集。
// LOCATION 出现在集合里只表示“可以发起单次限时会话”，不是长期授权。
export function sharedCapabilities(ageBandA, ageBandB) {
  const a = new Set(capabilitiesForAgeBand(ageBandA));
  return CAPABILITIES.filter((cap) => a.has(cap) && capabilitiesForAgeBand(ageBandB).includes(cap));
}

export function isExpired(deadline, now = Date.now()) {
  return deadline != null && now > deadline;
}

// 家长可读的理由说明：解释“一段联系为什么被允许或阻断”时直接引用。
export const REASON_TEXT = Object.freeze({
  [REASON_CODES.INTRO_REQUIRED]: "需要先通过一次真实相识：面对面短码、学校证明或监护人引荐。",
  [REASON_CODES.INTRO_EXPIRED]: "相识凭证已过期，需当面或通过学校、监护人重新获取。",
  [REASON_CODES.INTRO_ALREADY_USED]: "该相识凭证已被使用过，一次性凭证不能重复加友。",
  [REASON_CODES.REQUEST_EXPIRED]: "加友请求超过 7 天未完成双方确认与监护同意，已自动失效。",
  [REASON_CODES.REQUEST_DUPLICATED]: "已有相同的待处理加友请求，离线重传不会重复建立关系。",
  [REASON_CODES.PEER_CONFIRMATION_REQUIRED]: "还在等待对方孩子确认。",
  [REASON_CODES.GUARDIAN_CONSENT_REQUIRED]: "还在等待一方或双方监护人同意。",
  [REASON_CODES.GUARDIAN_CONSENT_WITHDRAWN]: "一方监护人已撤回同意，该联系已中断。",
  [REASON_CODES.AGE_GATE_BLOCKED]: "按双方孩子的年龄段，此功能暂不开放；联系双方按低龄一方的范围开放。",
  [REASON_CODES.LOCATION_SESSION_REQUIRED]: "位置分享需要逐次、限时的会话授权，没有长期位置权限。",
  [REASON_CODES.BRAND_NOT_IN_FEDERATION]: "对方所属品牌不在互通联盟内，无法建立跨品牌联系。",
  [REASON_CODES.BRAND_EXIT_NO_NEW]: "对方品牌正在退出联盟，过渡期内不再建立新联系；已有联系在过渡期内保留。",
  [REASON_CODES.BRAND_EXIT_TERMINATED]: "对方品牌已结束退出过渡期，跨品牌联系已终止，交换标识已被要求删除。",
  [REASON_CODES.RELATIONSHIP_REVOKED]: "该联系已被撤销，各方缓存会在承诺的 24 小时内失效。",
  [REASON_CODES.DEVICE_REBIND_PENDING]: "一方正在进行设备换绑，换绑完成前暂不能使用该跨品牌联系；关系不会因此被删除。",
  [REASON_CODES.GUARDIANSHIP_GRACE_PENDING]: "监护信息正在变更，有 30 天宽限期等待新监护人确认；期间联系暂时挂起，不会立即断开。",
  [REASON_CODES.GUARDIANSHIP_GRACE_EXPIRED]: "监护权变更宽限期已过仍未重新确认，联系已终止。",
  [REASON_CODES.MIGRATION_PENDING_RECONSENT]: "账号刚迁移到新品牌，需在 14 天内由监护人和对方重新确认后才能继续。",
  [REASON_CODES.MIGRATION_RECONSENT_EXPIRED]: "迁移重新确认窗口已过，跨品牌联系已终止。",
  [REASON_CODES.COMPLAINT_UNDER_REVIEW]: "该联系正处于安全投诉调查期间，暂时挂起。",
  [REASON_CODES.EMERGENCY_ONLY]: "紧急联系人例外：仅限本次紧急事由，24 小时内有效，事后会通知双方监护人。",
  [REASON_CODES.EMERGENCY_EXPIRED]: "紧急联系时限已到，临时通道已关闭。",
});
