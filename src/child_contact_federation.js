// child_contact_federation 领域词汇表。
//
// 事件名称遵循"一次相识 -> 加友 -> 双向确认 -> 监护同意 -> 成关系 ->
// 按年龄分级开放能力 -> 可撤销 / 可迁移 / 可复核"的窄通路，
// 所有跨品牌交换只携带完成当前动作所需的最少标识（见 identifiers.js）。

export const EVENT_KINDS = Object.freeze([
  // 监护人在本方平台建立了真实监护关系（窄通路的根，不跨品牌交换）。
  "GUARDIAN_LINKED",

  // 一次相识：学校证明或面对面短码，一次性、短时效，用完即焚。
  "INTRO_PROOF_ISSUED",

  // 加友请求（携带一次性 intro_token，而非孩子档案）。
  "FRIEND_REQUESTED",

  // 被请求方儿童/家长预览后作出的回应。
  "FRIEND_RESPONDED",

  // 双方儿童相互确认（年龄较大的分段可由儿童按各司法辖区规则先行确认）。
  "CONTACT_CONFIRMED_BY_CHILD",

  // 被请求方监护人同意（监护同意是关系生效的必要条件）。
  "GUARDIAN_CONSENT_GRANTED",

  // 旧名兼容：双向确认 + 监护同意全部完成后发出。
  "CONTACT_CONFIRMED",

  // 按年龄段开放（或回收）文字 / 语音 / 位置 / 群组能力。
  "CAPABILITY_GRANTED",
  "CAPABILITY_REVOKED",

  // 离线手表带客户端记录号重发同一命令：服务端幂等返回首结果，不造第二份关系。
  "COMMAND_DEDUPLICATED",

  // 撤销：立即切断消息与位置，只读副本按承诺时间（24h）失效。
  "RELATIONSHIP_REVOKED",
    // 位置是独立同意项：只有监护人为本关系单独开启时才允许交换。
  "LOCATION_SESSION_STARTED",
  "LOCATION_SESSION_ENDED",

  // 设备换绑：发起后进入 3 天确认期，监护人确认后完成。
  "DEVICE_REBIND_REQUESTED",
  "DEVICE_REBIND_CONFIRMED",

  // 连续路径：监护权改变、账号迁移、品牌退出、紧急联系人。
  "GUARDIANSHIP_CHANGED",
  "ACCOUNT_MIGRATED",
  "BRAND_EXITED_ALLIANCE",
  "EMERGENCY_CONTACT_DECLARED",
  "EMERGENCY_CONTACT_REVIEWED",

  // 安全投诉：事实只进证据库，不随业务流传播。
  "SAFETY_REPORT_FILED",

  // 可解释性：家长看到的每一条允许 / 阻断，对应一个公开原因码。
  "DECISION_LOGGED",
]);

// 为什么被允许 / 被阻断。家长端可以据此把技术状态翻译成一句话。
export const REASON_CODES = Object.freeze({
  OK: "OK",

  // 阻断类
  INTRO_MISSING: "INTRO_MISSING",                 // 没有一次相识凭证，拒绝陌生人搜索式加友
  INTRO_EXPIRED: "INTRO_EXPIRED",                 // 学校证明/短码已过有效期
  INTRO_REDEEMED: "INTRO_REDEEMED",               // 一次性凭证已使用
  GUARDIAN_MISSING: "GUARDIAN_MISSING",           // 任一方缺少已验证监护人
  GUARDIAN_CONSENT_PENDING: "GUARDIAN_CONSENT_PENDING",
  CHILD_CONFIRM_PENDING: "CHILD_CONFIRM_PENDING",
  REQUEST_EXPIRED: "REQUEST_EXPIRED",
  REQUEST_CANCELLED: "REQUEST_CANCELLED",
  RELATIONSHIP_NOT_ACTIVE: "RELATIONSHIP_NOT_ACTIVE",
  CAPABILITY_NOT_GRANTED_FOR_AGE: "CAPABILITY_NOT_GRANTED_FOR_AGE",
  LOCATION_REQUIRES_SEPARATE_CONSENT: "LOCATION_REQUIRES_SEPARATE_CONSENT",
  LOCATION_SESSION_CLOSED: "LOCATION_SESSION_CLOSED",
  DUPLICATE_COMMAND: "DUPLICATE_COMMAND",
  DEVICE_REBINDING_PENDING: "DEVICE_REBINDING_PENDING",
  GUARDIANSHIP_TRANSITION_PENDING: "GUARDIANSHIP_TRANSITION_IN_PROGRESS",
  BRAND_SUSPENDED: "BRAND_SUSPENDED",
  EMERGENCY_LIMIT_EXCEEDED: "EMERGENCY_LIMIT_EXCEEDED",
  EMERGENCY_REVIEW_DUE: "EMERGENCY_REVIEW_DUE",
  SAFETY_HOLD: "SAFETY_HOLD",
  CACHE_PENDING_EXPIRY: "CACHE_PENDING_EXPIRY",   // 已撤销，只读副本在承诺失效窗口内
});

// 能力键（与事件名后缀对应）。
export const CAPABILITIES = Object.freeze(["TEXT", "VOICE", "LOCATION", "GROUP"]);

// 家长端可读懂的一句话。不含任何儿童资料，只描述规则本身。
export const REASON_TEXT = Object.freeze({
  OK: "通道开启：双向确认与监护人均已完成，请求的能力在本年龄段开放。",
  INTRO_MISSING: "已阻断：跨品牌加友必须先有一次相识（学校证明或面对面短码），不开放陌生人搜索。",
  INTRO_EXPIRED: "已阻断：相识凭证已过期，请重新面对面生成或由学校出具。",
  INTRO_REDEEMED: "已阻断：相识凭证只能使用一次，需要重新生成。",
  GUARDIAN_MISSING: "已阻断：双方都必须有已验证的监护人才能建立联系。",
  GUARDIAN_CONSENT_PENDING: "暂未开通：等待被请求方监护人同意。",
  CHILD_CONFIRM_PENDING: "暂未开通：等待孩子本人确认。",
  REQUEST_EXPIRED: "已失效：加友请求超过 7 天未处理，可重新发起。",
  REQUEST_CANCELLED: "已取消：请求被发起方监护人撤回。",
  RELATIONSHIP_NOT_ACTIVE: "已阻断：该联系当前不处于生效状态（从未生效、已撤销或正在变更）。",
  CAPABILITY_NOT_GRANTED_FOR_AGE: "已阻断：该能力不对当前年龄段开放，或未被授予。",
  LOCATION_REQUIRES_SEPARATE_CONSENT: "已阻断：位置分享需要监护人为这条联系单独开启，不随加友默认开放。",
  LOCATION_SESSION_CLOSED: "已阻断：位置会话已结束或被撤销方切断。",
  DUPLICATE_COMMAND: "重复请求：这是离线手表重发的同一指令，已沿用首次结果，未产生重复关系。",
  DEVICE_REBINDING_PENDING: "暂不可用：设备正在换绑确认期内，换绑不改变关系，但需等待确认。",
  GUARDIANSHIP_TRANSITION_PENDING: "暂受影响：监护权变更流程进行中，老联系人在 30 天宽限期内保留，等待新监护人复核。",
  BRAND_SUSPENDED: "已阻断：对方所属品牌目前处于暂停/退出状态。",
  EMERGENCY_LIMIT_EXCEEDED: "已阻断：每个儿童最多预设 3 个紧急联系人，请先撤销一个。",
  EMERGENCY_REVIEW_DUE: "已暂停：紧急联系人已超过 90 天未复核，请监护人重新确认后恢复。",
  SAFETY_HOLD: "已暂停：该联系正在安全投诉处置流程中，处置完成前一切能力关闭。",
  CACHE_PENDING_EXPIRY: "已撤销：各方只读缓存将在承诺时间（24 小时）内失效，消息与位置此刻起不投递。",
});

export const REQUIRED_FIELDS = Object.freeze(["event_id", "kind", "occurred_at", "subject_id", "payload"]);

export function validateEvent(record) {
  const problems = REQUIRED_FIELDS.filter((name) => !(name in record));
  if (!EVENT_KINDS.includes(record.kind)) problems.push("kind");
  return problems;
}
