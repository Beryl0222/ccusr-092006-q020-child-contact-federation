// 儿童联系人跨品牌互通：领域约定。
//
// 这里只定义各方（设备厂商、学校验证方、联盟清算服务）共用的词汇：
// 事件种类、关系状态、介绍方式、能力、阻断理由码，以及跨品牌交换时
// 允许出现的“最少标识”白名单。任何不在白名单内的字段（出生日期、
// 设备序列号、真实姓名、通讯录等）都不得跨品牌传递。

export const EVENT_KINDS = Object.freeze([
  "GUARDIAN_LINKED", // 监护人绑定儿童账号
  "INTRO_PROOF_ISSUED", // 一次性相识凭证签发（短码 / 学校证明 / 监护人引荐）
  "INTRO_PROOF_REDEEMED", // 相识凭证被一次性核销
  "FRIEND_REQUESTED", // 加友请求发出（有期限）
  "CHILD_CONFIRMED", // 儿童本人确认
  "GUARDIAN_CONSENTED", // 监护人同意
  "GUARDIAN_CONSENT_WITHDRAWN", // 监护人撤回同意
  "CONTACT_CONFIRMED", // 双向确认 + 双方监护同意齐备，关系成立
  "CAPABILITY_GRANTED", // 按年龄段开放能力
  "LOCATION_SESSION_GRANTED", // 位置分享的单次、限时会话
  "LOCATION_SESSION_CLOSED",
  "RELATIONSHIP_SUSPENDED", // 关系挂起（投诉调查、迁移/监护权等待期超时等）
  "RELATIONSHIP_REVOKED", // 撤销
  "CACHE_INVALIDATION_ACK", // 某厂商确认已按承诺失效本地缓存
  "DEVICE_REBIND_STARTED", // 设备换绑开始（有期限）
  "DEVICE_REBIND_COMPLETED",
  "GUARDIANSHIP_TRANSFER_STARTED", // 监护权改变，进入连续处理宽限期
  "GUARDIANSHIP_REAFFIRMED", // 新监护人在宽限期内重新确认
  "ACCOUNT_MIGRATION_STARTED", // 儿童账号跨品牌迁移开始（有重新确认窗口）
  "ACCOUNT_MIGRATION_COMPLETED",
  "BRAND_EXIT_DECLARED", // 某品牌退出联盟
  "BRAND_EXIT_WINDDOWN_ENDED", // 退出过渡期结束
  "EMERGENCY_CONTACT_DECLARED", // 紧急联系人例外（单方声明、限时、事后通知）
  "EMERGENCY_CONTACT_EXPIRED",
  "COMPLAINT_FILED", // 跨品牌投诉 / 申诉
  "COMPLAINT_RESOLVED",
  "EVIDENCE_SEALED", // 安全投诉证据另行封存
]);

// 关系状态机：
// PENDING -> ACTIVE -> REVOKED（终态）
//                 \-> SUSPENDED -> ACTIVE（障碍消除）/ TERMINATED（终态）
// EMERGENCY_LIMITED 是旁路：不经过双向确认，限时存续，到期 TERMINATED，
// 也可在期内补齐正常流程后转 ACTIVE。
export const RELATIONSHIP_STATES = Object.freeze([
  "PENDING",
  "ACTIVE",
  "SUSPENDED",
  "EMERGENCY_LIMITED",
  "REVOKED",
  "TERMINATED",
]);

export const INTRO_KINDS = Object.freeze([
  "FACE_TO_FACE_SHORT_CODE", // 面对面短码：现场生成、一次相识、最短有效期
  "SCHOOL_ATTESTATION", // 学校证明：证明同班/同校事实，一次相识
  "GUARDIAN_REFERENCE", // 监护人引荐：监护人先建立的真实关系
]);

export const CAPABILITIES = Object.freeze(["TEXT", "VOICE", "LOCATION", "GROUP"]);

export const COMPLAINT_CATEGORIES = Object.freeze([
  "HARASSMENT", // 骚扰/不当内容
  "SAFETY_RISK", // 安全风险
  "WRONGFUL_BLOCK", // 认为联系被错误阻断
  "DATA_REQUEST", // 对跨品牌交换数据的查询/删除请求
]);

// 阻断/挂起理由码。policy.REASON_TEXT 给出家长能读懂的中文解释。
export const REASON_CODES = Object.freeze({
  INTRO_REQUIRED: "INTRO_REQUIRED",
  INTRO_EXPIRED: "INTRO_EXPIRED",
  INTRO_ALREADY_USED: "INTRO_ALREADY_USED",
  REQUEST_EXPIRED: "REQUEST_EXPIRED",
  REQUEST_DUPLICATED: "REQUEST_DUPLICATED",
  PEER_CONFIRMATION_REQUIRED: "PEER_CONFIRMATION_REQUIRED",
  GUARDIAN_CONSENT_REQUIRED: "GUARDIAN_CONSENT_REQUIRED",
  GUARDIAN_CONSENT_WITHDRAWN: "GUARDIAN_CONSENT_WITHDRAWN",
  AGE_GATE_BLOCKED: "AGE_GATE_BLOCKED",
  LOCATION_SESSION_REQUIRED: "LOCATION_SESSION_REQUIRED",
  BRAND_NOT_IN_FEDERATION: "BRAND_NOT_IN_FEDERATION",
  BRAND_EXIT_NO_NEW: "BRAND_EXIT_NO_NEW",
  BRAND_EXIT_TERMINATED: "BRAND_EXIT_TERMINATED",
  RELATIONSHIP_REVOKED: "RELATIONSHIP_REVOKED",
  DEVICE_REBIND_PENDING: "DEVICE_REBIND_PENDING",
  GUARDIANSHIP_GRACE_PENDING: "GUARDIANSHIP_GRACE_PENDING",
  GUARDIANSHIP_GRACE_EXPIRED: "GUARDIANSHIP_GRACE_EXPIRED",
  MIGRATION_PENDING_RECONSENT: "MIGRATION_PENDING_RECONSENT",
  MIGRATION_RECONSENT_EXPIRED: "MIGRATION_RECONSENT_EXPIRED",
  COMPLAINT_UNDER_REVIEW: "COMPLAINT_UNDER_REVIEW",
  EMERGENCY_ONLY: "EMERGENCY_ONLY",
  EMERGENCY_EXPIRED: "EMERGENCY_EXPIRED",
});

// 事件最小字段（既有约定，保持不变）。
export const REQUIRED_FIELDS = Object.freeze([
  "event_id",
  "kind",
  "occurred_at",
  "subject_id",
  "payload",
]);

// 跨品牌“认识一个联系人”时允许交换的最少标识。
// 出生日期、精确年龄、设备号、真实姓名、通讯录、学校班级明细等一律不跨品牌。
// age_band 只到年龄段，不到生日；display_label 必须是监护人审核过的昵称，可为缺省。
export const MINIMAL_CONTACT_FIELDS = Object.freeze([
  "federation_pseudonym", // 联盟内不透明假名，换品牌/撤销后可更换
  "brand_id", // 对方所属品牌，用于路由
  "age_band", // 粗粒度年龄段，仅用于能力分级
  "intro_ref", // 一次性相识凭证引用，不含凭证内容本身
  "display_label", // 监护人审核昵称，可缺省
]);

export function validateEvent(record) {
  const problems = REQUIRED_FIELDS.filter((name) => !(name in record));
  if (!EVENT_KINDS.includes(record.kind)) problems.push("kind");
  return problems;
}

// 校验跨品牌联系人视图没有超出最少标识白名单。
export function findExcessiveFields(contactView) {
  return Object.keys(contactView).filter((key) => !MINIMAL_CONTACT_FIELDS.includes(key));
}
