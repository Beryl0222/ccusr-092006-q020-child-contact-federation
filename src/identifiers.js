// 最少标识：跨品牌交换的内容只够"完成这一次联系"，不含孩子档案、通讯录或社交图谱。
//
// Handle（成对假名）：
//  - 每个儿童在每一段关系中使用一次性派生出的假名，品牌之间看不到稳定的儿童 ID；
//  - 派生需要联盟盐，账号迁移时轮换盐（rotateHandleSalt），旧假名在迁移窗口后不可链接；
//  - 同品牌内部可用 child_id 反查（resolve），跨品牌只拿到 handle 字符串。
//
// 投影（projection）：不同事件携带不同的最小字段集，宁少勿多。

import { createHash } from "node:crypto";

function hash(...parts) {
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32);
}

export function deriveHandle(childId, peerBrandId, salt) {
  // 对端品牌 + 儿童 + 盐：同一儿童对不同品牌呈现不同假名。
  return `h_${hash(peerBrandId, childId, salt)}`;
}

// 迁移：换盐后新手柄不同；迁移窗口内同时承认新旧（见 federation 的 migration 路径）。
export function rotateHandleSalt(oldSalt) {
  return hash("salt-rotation", oldSalt, Date.now().toString());
}

// 一次相识凭证兑换后，加友请求里携带的最小投影。
export function projectFriendRequest({ introToken, fromBrand, toBrand, childHandle, ageBand }) {
  return {
    intro_token: introToken,         // 一次性，兑换后即焚
    from_brand: fromBrand,
    to_brand: toBrand,
    child_handle: childHandle,      // 关系假名，不是真实 ID
    age_band: ageBand,              // 只有年龄段（如 "8-11"），没有出生日期
  };
}

// 关系生效后，消息路由所需的最小投影。刻意不含昵称、头像、学校、位置。
export function projectRouting(relationship) {
  return {
    relationship_id: relationship.id,
    a_handle: relationship.handle_a,
    b_handle: relationship.handle_b,
    brand_a: relationship.brand_a,
    brand_b: relationship.brand_b,
    active_capabilities: [...relationship.activeCaps],
    cache_expires_at: relationship.cache_expires_at, // 撤销时给出承诺失效时刻
  };
}

// 给家长看的解释卡片：只有规则事实，不暴露对方儿童资料。
export function projectExplanation(decision) {
  return {
    relationship_id: decision.relationshipId,
    allowed: decision.allowed,
    reason_code: decision.reasonCode,
    reason_text: decision.reasonText,
    requested_capability: decision.capability ?? null,
    next_action: decision.nextAction ?? null,   // 例如"等待监护人同意"
    expires_at: decision.expiresAt ?? null,
    // 对方仅显示品牌 + 关系假名首末位，家长能认出"是哪条联系"但看不到档案。
    peer_brief: decision.peerBrand ? `${decision.peerBrand}:${maskHandle(decision.peerHandle)}` : null,
  };
}

function maskHandle(handle) {
  if (!handle) return null;
  if (handle.length <= 4) return "****";
  return `${handle.slice(0, 3)}…${handle.slice(-2)}`;
}

// 跨品牌申诉信封：只携带本条联系与本次事件的引用，其他儿童的资料不进入信封。
export function projectAppealEnvelope({ relationshipId, eventRef, reporterBrand, respondentBrand, category, detail }) {
  return {
    schema: "ccf-appeal/1",
    relationship_ref: relationshipId,        // 双方都能凭此定位到"这一条"关系
    event_ref: eventRef,                     // 证据库内引用，不是证据本身
    reporter_brand: reporterBrand,
    respondent_brand: respondentBrand,
    category,                               // 例如 HARASSMENT / WRONG_IDENTITY / UNSOLICITED
    detail: detail ?? null,                  // 文字陈述，由提交方自行最小化
    other_children_profiles: [],             // 结构性保证：接口不接受其他儿童资料字段
  };
}
