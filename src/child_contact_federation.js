// 向后兼容入口：早期资料从 child_contact_federation.js 导出基础约定，
// 现统一收敛到 domain.js，旧引用保持可用。
export {
  EVENT_KINDS,
  REQUIRED_FIELDS,
  RELATIONSHIP_STATES,
  INTRO_KINDS,
  CAPABILITIES,
  COMPLAINT_CATEGORIES,
  REASON_CODES,
  MINIMAL_CONTACT_FIELDS,
  validateEvent,
  findExcessiveFields,
} from "./domain.js";
