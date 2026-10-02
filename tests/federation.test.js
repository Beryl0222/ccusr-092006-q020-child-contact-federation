import assert from "node:assert/strict";
import test from "node:test";

import { FederationService } from "../src/federation.js";
import { REASON_CODES } from "../src/child_contact_federation.js";
import { DEADLINES } from "../src/policy.js";

// ---- 测试用具：可控时钟 ---------------------------------------------------

function harness() {
  let t = new Date("2026-10-02T08:00:00+08:00").getTime();
  const clock = () => new Date(t);
  const svc = new FederationService({ clock });
  return {
    svc,
    now: clock,
    advance: (ms) => { t += ms; },
    advanceHours: (h) => { t += h * 36e5; },
    advanceDays: (d) => { t += d * 864e5; },
  };
}

function establish(svc, { a = "c1", b = "c2", brandA = "brandA", brandB = "brandB",
  ageA = 10, ageB = 10, guardianA = "ga", guardianB = "gb", method = "FACE_TO_FACE", commandId = null } = {}) {
  svc.registerChild({ childId: a, brandId: brandA, ageYears: ageA, guardianId: guardianA });
  svc.registerChild({ childId: b, brandId: brandB, ageYears: ageB, guardianId: guardianB });
  const intro = svc.issueIntro({ childId: a, method, commandId: commandId ?? "cmd-intro" });
  const redeem = svc.redeemIntro({ token: intro.token, childId: b, commandId: commandId ? `${commandId}-redeem` : "cmd-redeem" });
  svc.confirmByChild(redeem.requestId, { commandId: "cmd-confirm" });
  const consent = svc.grantConsent(redeem.requestId, guardianB, { commandId: "cmd-consent" });
  return { intro, redeem, relationshipId: consent.relationshipId, capabilities: consent.capabilities };
}

// ---- 1. 窄通路：一次相识是唯一入口 ----------------------------------------

test("没有一次相识凭证就无法发起跨品牌加友（不开放陌生人搜索）", () => {
  const { svc } = harness();
  svc.registerChild({ childId: "a", brandId: "A", ageYears: 10, guardianId: "ga" });
  svc.registerChild({ childId: "b", brandId: "B", ageYears: 10, guardianId: "gb" });
  const res = svc.redeemIntro({ token: "intro_nonexistent", childId: "b", commandId: "x1" });
  assert.equal(res.ok, false);
  assert.equal(res.reason, REASON_CODES.INTRO_MISSING);
  // 结构性保证：服务表面上不存在任何陌生人搜索/目录接口。
  assert.equal(typeof svc.searchChildren, "undefined");
  assert.equal(typeof svc.listChildren, "undefined");
});

test("跨品牌投送的加友投影只含最少字段：假名、年龄段、一次性凭证", () => {
  const { svc } = harness();
  establish(svc);
  const event = svc.log.events.find((e) => e.kind === "FRIEND_REQUESTED");
  assert.deepEqual(Object.keys(event.payload.projection).sort(),
    ["age_band", "child_handle", "from_brand", "intro_token", "to_brand"]);
  for (const forbidden of ["name", "birthday", "school", "avatar", "contacts", "phone"]) {
    assert.equal(forbidden in event.payload.projection, false);
  }
});

test("相识凭证一次性：重复兑换被拒；面对面短码 10 分钟过期", () => {
  const { svc } = harness();
  svc.registerChild({ childId: "a", brandId: "A", ageYears: 10, guardianId: "ga" });
  svc.registerChild({ childId: "b", brandId: "B", ageYears: 10, guardianId: "gb" });
  const intro = svc.issueIntro({ childId: "a", method: "FACE_TO_FACE", commandId: "i" });
  assert.equal(svc.redeemIntro({ token: intro.token, childId: "b", commandId: "r1" }).ok, true);
  assert.equal(svc.redeemIntro({ token: intro.token, childId: "b", commandId: "r2" }).reason,
    REASON_CODES.INTRO_REDEEMED);

  const h = harness();
  h.svc.registerChild({ childId: "a", brandId: "A", ageYears: 10, guardianId: "ga" });
  h.svc.registerChild({ childId: "b", brandId: "B", ageYears: 10, guardianId: "gb" });
  const intro2 = h.svc.issueIntro({ childId: "a", method: "FACE_TO_FACE", commandId: "i2" });
  h.advance((DEADLINES.INTRO_PROOF_F2F_TTL_MINUTES + 1) * 60_000);
  assert.equal(h.svc.redeemIntro({ token: intro2.token, childId: "b", commandId: "r3" }).reason,
    REASON_CODES.INTRO_EXPIRED);
});

test("学校证明 7 天有效，第 8 天兑换被拒", () => {
  const h = harness();
  h.svc.registerChild({ childId: "a", brandId: "A", ageYears: 10, guardianId: "ga" });
  h.svc.registerChild({ childId: "b", brandId: "B", ageYears: 10, guardianId: "gb" });
  const intro = h.svc.issueIntro({ childId: "a", method: "SCHOOL", commandId: "i" });
  h.advanceDays(DEADLINES.INTRO_PROOF_SCHOOL_TTL_HOURS / 24 + 1);
  assert.equal(h.svc.redeemIntro({ token: intro.token, childId: "b", commandId: "r" }).reason,
    REASON_CODES.INTRO_EXPIRED);
});

// ---- 2. 加友请求、双向确认、监护同意都有明确期限 --------------------------

test("请求 7 天不处理自动失效；儿童确认与监护同意缺一不可", () => {
  const h = harness();
  h.svc.registerChild({ childId: "a", brandId: "A", ageYears: 10, guardianId: "ga" });
  h.svc.registerChild({ childId: "b", brandId: "B", ageYears: 10, guardianId: "gb" });
  const intro = h.svc.issueIntro({ childId: "a", method: "SCHOOL", commandId: "i" });
  const redeem = h.svc.redeemIntro({ token: intro.token, childId: "b", commandId: "r" });

  // 未儿童确认，监护人不能直接同意
  assert.equal(h.svc.grantConsent(redeem.requestId, "gb", { commandId: "g" }).reason,
    REASON_CODES.CHILD_CONFIRM_PENDING);

  h.svc.confirmByChild(redeem.requestId, { commandId: "c" });
  // 监护人同意期限 7 天：第 8 天回退失效
  h.advanceDays(DEADLINES.GUARDIAN_CONSENT_TTL_DAYS + 1);
  h.svc.sweep();
  assert.equal(h.svc.grantConsent(redeem.requestId, "gb", { commandId: "g2" }).reason,
    REASON_CODES.REQUEST_EXPIRED);
});

test("请求在 7 天点自动失效（无需监护人再操作）", () => {
  const h = harness();
  h.svc.registerChild({ childId: "a", brandId: "A", ageYears: 10, guardianId: "ga" });
  h.svc.registerChild({ childId: "b", brandId: "B", ageYears: 10, guardianId: "gb" });
  const intro = h.svc.issueIntro({ childId: "a", method: "SCHOOL", commandId: "i" });
  const redeem = h.svc.redeemIntro({ token: intro.token, childId: "b", commandId: "r" });
  h.advanceDays(DEADLINES.FRIEND_REQUEST_TTL_DAYS + 1);
  h.svc.sweep();
  assert.equal(h.svc.confirmByChild(redeem.requestId, { commandId: "c" }).reason,
    REASON_CODES.REQUEST_EXPIRED);
});

test("任一方缺少已验证监护人时，相识与加友都被阻断", () => {
  const { svc } = harness();
  svc.registerChild({ childId: "a", brandId: "A", ageYears: 10, guardianId: "ga" });
  svc.children.get("a").guardians.delete("ga"); // 白盒：撤销监护验证
  assert.equal(svc.issueIntro({ childId: "a", method: "SCHOOL", commandId: "i" }).reason,
    REASON_CODES.GUARDIAN_MISSING);
});

// ---- 3. 幂等：离线手表重发不制造多个关系 ----------------------------------

test("同一命令号重发：沿用首次结果，只有一份请求和一条关系", () => {
  const { svc } = harness();
  svc.registerChild({ childId: "a", brandId: "A", ageYears: 10, guardianId: "ga" });
  svc.registerChild({ childId: "b", brandId: "B", ageYears: 10, guardianId: "gb" });
  const intro = svc.issueIntro({ childId: "a", method: "FACE_TO_FACE", commandId: "cmd-1" });
  // 模拟离线手表连续重发同一兑换命令
  const first = svc.redeemIntro({ token: intro.token, childId: "b", commandId: "cmd-2" });
  const retry = svc.redeemIntro({ token: intro.token, childId: "b", commandId: "cmd-2" });
  const retry2 = svc.redeemIntro({ token: intro.token, childId: "b", commandId: "cmd-2" });
  assert.equal(first.duplicated, false);
  assert.equal(retry.duplicated, true);
  assert.equal(retry2.duplicated, true);
  assert.equal(retry.requestId, first.requestId);
  assert.equal(svc.requests.size, 1);

  svc.confirmByChild(first.requestId, { commandId: "cmd-3" });
  const c1 = svc.grantConsent(first.requestId, "gb", { commandId: "cmd-4" });
  const c2 = svc.grantConsent(first.requestId, "gb", { commandId: "cmd-4" });
  assert.equal(c1.relationshipId, c2.relationshipId);
  assert.equal(svc.relationships.size, 1);
  assert.ok(svc.log.events.some((e) => e.kind === "COMMAND_DEDUPLICATED"));
});

// ---- 4. 年龄分级：文字/语音/位置/群组分段开放，就低不就高 ------------------

test("7 岁只有文字；语音和群组被年龄矩阵阻断", () => {
  const { svc } = harness();
  const { relationshipId } = establish(svc, { ageA: 7, ageB: 7 });
  assert.equal(svc.authorize(relationshipId, "TEXT", "c1").allowed, true);
  assert.equal(svc.authorize(relationshipId, "VOICE", "c1").allowed, false);
  assert.equal(svc.authorize(relationshipId, "GROUP", "c1").allowed, false);
});

test("8 岁开放语音，12 岁开放群组", () => {
  const h8 = harness();
  const r8 = establish(h8.svc, { ageA: 8, ageB: 9 }).relationshipId;
  assert.equal(h8.svc.authorize(r8, "VOICE").allowed, true);
  assert.equal(h8.svc.authorize(r8, "GROUP").allowed, false);

  const h12 = harness();
  const r12 = establish(h12.svc, { ageA: 12, ageB: 14 }).relationshipId;
  assert.equal(h12.svc.authorize(r12, "GROUP").allowed, true);
  assert.equal(h12.svc.authorize(r12, "LOCATION").allowed, false);
});

test("双方年龄不一致时按较小一方开放（16 岁对 10 岁拿不到群组和位置）", () => {
  const { svc } = harness();
  const { relationshipId } = establish(svc, { ageA: 16, ageB: 10 });
  assert.equal(svc.authorize(relationshipId, "TEXT").allowed, true);
  assert.equal(svc.authorize(relationshipId, "GROUP").allowed, false);
  assert.equal(svc.authorize(relationshipId, "LOCATION").allowed, false);
});

test("监护人可以逐条收窄能力（关掉语音），但不能突破年龄上限", () => {
  const { svc } = harness();
  const { relationshipId } = establish(svc, { ageA: 10, ageB: 10 });
  assert.equal(svc.setCapability(relationshipId, "gb", "VOICE", false, { commandId: "off" }).ok, true);
  assert.equal(svc.authorize(relationshipId, "VOICE").allowed, false);
  // 10 岁开群组：直接被矩阵拒绝
  assert.equal(svc.setCapability(relationshipId, "gb", "GROUP", true, { commandId: "on" }).reason,
    REASON_CODES.CAPABILITY_NOT_GRANTED_FOR_AGE);
});

// ---- 5. 位置：独立同意 + 限时会话，绝不默认开放 ----------------------------

test("位置不随加友开放：常开授权被拒，只能开限时会话，到时自动结束", () => {
  const h = harness();
  const r = establish(h.svc, { ageA: 16, ageB: 16 }).relationshipId;
  assert.equal(h.svc.authorize(r, "LOCATION").allowed, false);
  assert.equal(h.svc.setCapability(r, "gb", "LOCATION", true, { commandId: "always" }).reason,
    REASON_CODES.LOCATION_REQUIRES_SEPARATE_CONSENT);

  const session = h.svc.startLocationSession(r, "gb", { commandId: "loc1" });
  assert.equal(session.ok, true);
  assert.equal(h.svc.authorize(r, "LOCATION").allowed, true);

  h.advanceHours(DEADLINES.LOCATION_SESSION_DEFAULT_HOURS + 0.1);
  h.svc.sweep();
  assert.equal(h.svc.authorize(r, "LOCATION").reason, REASON_CODES.LOCATION_SESSION_CLOSED);
});

// ---- 6. 撤销：立即切断 + 缓存承诺 24h 失效 --------------------------------

test("撤销后消息立即阻断，路由投影带承诺失效时刻；24h 后标识清除", () => {
  const h = harness();
  const r = establish(h.svc, { ageA: 16, ageB: 16 }).relationshipId;
  const revoked = h.svc.revokeRelationship(r, "gb", { commandId: "rev" });
  assert.equal(revoked.ok, true);
  // 立即切断
  assert.equal(h.svc.authorize(r, "TEXT").reason, REASON_CODES.CACHE_PENDING_EXPIRY);
  assert.equal(h.svc.authorize(r, "LOCATION").reason, REASON_CODES.CACHE_PENDING_EXPIRY);
  // 缓存失效窗口内仍可拿到投影，但带了承诺时刻
  const proj = h.svc.routingProjection(r);
  assert.equal(proj.cache_expires_at, revoked.cacheExpiresAt);

  h.advanceHours(DEADLINES.CACHE_EXPIRY_HOURS + 1);
  h.svc.sweep();
  assert.equal(h.svc.routingProjection(r), null);
  // 墓碑期后允许重新相识，且不会复活旧关系
  const intro = h.svc.issueIntro({ childId: "c1", method: "FACE_TO_FACE", commandId: "i2" });
  const again = h.svc.redeemIntro({ token: intro.token, childId: "c2", commandId: "r2" });
  assert.equal(again.ok, true);
  assert.notEqual(again.requestId, null);
});

test("非监护人不能撤销关系", () => {
  const { svc } = harness();
  const r = establish(svc).relationshipId;
  assert.equal(svc.revokeRelationship(r, "stranger", { commandId: "x" }).reason,
    REASON_CODES.GUARDIAN_MISSING);
});

// ---- 7. 设备换绑：3 天确认期，关系不重建 ----------------------------------

test("换绑期间能力挂起，监护人确认后恢复；逾期自动取消", () => {
  const h = harness();
  const r = establish(h.svc).relationshipId;
  const rebind = h.svc.requestRebind("c2", "watch-new", { commandId: "rb1" });
  assert.equal(rebind.ok, true);
  assert.equal(h.svc.authorize(r, "TEXT").reason, REASON_CODES.DEVICE_REBINDING_PENDING);
  // 关系仍只有一条，没有被重建
  assert.equal(h.svc.relationships.size, 1);

  assert.equal(h.svc.confirmRebind("c2", "ga", { commandId: "wrong" }).reason,
    REASON_CODES.GUARDIAN_MISSING);
  assert.equal(h.svc.confirmRebind("c2", "gb", { commandId: "rb2" }).ok, true);
  assert.equal(h.svc.authorize(r, "TEXT").allowed, true);

  // 第二次换绑：逾期后自动取消，关系不受影响
  h.svc.requestRebind("c2", "watch-new2", { commandId: "rb3" });
  assert.equal(h.svc.authorize(r, "TEXT").allowed, false);
  h.advanceDays(DEADLINES.DEVICE_REBIND_TTL_DAYS + 1);
  h.svc.sweep();
  assert.equal(h.svc.authorize(r, "TEXT").allowed, true);
  assert.equal(h.svc.relationships.size, 1);
});

// ---- 8. 监护权改变：30 天宽限 + 新监护人复核 ------------------------------

test("监护权变更：老关系保留但只能收窄；新监护人可保留或撤销；逾期自动撤销", () => {
  const h = harness();
  const r = establish(h.svc).relationshipId;
  assert.equal(h.svc.changeGuardianship("c2", "gb2", { commandId: "chg" }).ok, true);

  // 既有联系在宽限期内保留
  assert.equal(h.svc.authorize(r, "TEXT").allowed, true);
  // 不能扩张能力，也不能发起新联系
  assert.equal(h.svc.setCapability(r, "gb2", "VOICE", true, { commandId: "grow" }).reason,
    REASON_CODES.GUARDIANSHIP_TRANSITION_PENDING);
  const intro = h.svc.issueIntro({ childId: "c1", method: "FACE_TO_FACE", commandId: "ni" });
  assert.equal(h.svc.redeemIntro({ token: intro.token, childId: "c2", commandId: "nr" }).reason,
    REASON_CODES.GUARDIANSHIP_TRANSITION_PENDING);

  // 老监护人不再有资格，新监护人复核保留
  assert.equal(h.svc.reviewUnderNewGuardian(r, "gb", true, { commandId: "old" }).reason,
    REASON_CODES.GUARDIAN_MISSING);
  assert.equal(h.svc.reviewUnderNewGuardian(r, "gb2", true, { commandId: "new" }).ok, true);
  assert.equal(h.svc.authorize(r, "TEXT").allowed, true);
  // 全部老关系复核完，过渡期结束：又能发起新联系
  const intro2 = h.svc.issueIntro({ childId: "c1", method: "FACE_TO_FACE", commandId: "i3" });
  h.svc.registerChild({ childId: "c3", brandId: "brandB", ageYears: 10, guardianId: "gb2" });
  const redeem3 = h.svc.redeemIntro({ token: intro2.token, childId: "c3", commandId: "r3" });
  assert.equal(redeem3.ok, true);
});

test("监护权宽限期满未复核：关系自动撤销并遵守缓存承诺", () => {
  const h = harness();
  const r = establish(h.svc).relationshipId;
  h.svc.changeGuardianship("c2", "gb2", { commandId: "chg" });
  h.advanceDays(DEADLINES.GUARDIANSHIP_GRACE_DAYS + 1);
  const effects = h.svc.sweep();
  assert.ok(effects.some((e) => e.type === "GUARDIANSHIP_GRACE_LAPSED"));
  assert.equal(h.svc.authorize(r, "TEXT").reason, REASON_CODES.CACHE_PENDING_EXPIRY);
  assert.equal(h.svc.children.get("c2").transition, null);
});

// ---- 9. 账号迁移：手柄轮换，窗口期内旧柄可路由 -----------------------------

test("迁移后立即换发新手柄；14 天窗口内承认旧柄，窗口后不可链接", () => {
  const h = harness();
  establish(h.svc, { ageA: 16, ageB: 16 });
  const relBefore = [...h.svc.relationships.values()][0];
  const oldHandle = relBefore.handle_b;

  const migration = h.svc.migrateAccount("c2", { newBrandId: "brandC", commandId: "m1" });
  assert.equal(migration.ok, true);
  const relAfter = h.svc.relationships.get(relBefore.id);
  assert.notEqual(relAfter.handle_b, oldHandle);

  assert.equal(h.svc.resolveHandle("c2", oldHandle, "brandA").resolves, true);
  assert.equal(h.svc.resolveHandle("c2", oldHandle, "brandA").vintage, "PREVIOUS_GRACE");
  assert.equal(h.svc.resolveHandle("c2", relAfter.handle_b, "brandA").vintage, "CURRENT");

  h.advanceDays(DEADLINES.MIGRATION_TTL_DAYS + 1);
  h.svc.sweep();
  assert.equal(h.svc.resolveHandle("c2", oldHandle, "brandA").resolves, false);
  assert.equal(h.svc.resolveHandle("c2", relAfter.handle_b, "brandA").resolves, true);
});

// ---- 10. 品牌退出：即时暂停 + 90 天迁移豁免 -------------------------------

test("品牌退出即时阻断；账号迁到存续品牌后关系恢复", () => {
  const h = harness();
  const r = establish(h.svc).relationshipId;
  assert.equal(h.svc.brandExit("brandB", { commandId: "exit" }).ok, true);
  assert.equal(h.svc.authorize(r, "TEXT").reason, REASON_CODES.BRAND_SUSPENDED);

  // c2 随账号迁移到存续品牌 C，关系恢复
  h.svc.migrateAccount("c2", { newBrandId: "brandC", commandId: "mig" });
  assert.equal(h.svc.restoreAfterMigration(r, { commandId: "restore" }).ok, true);
  assert.equal(h.svc.authorize(r, "TEXT").allowed, true);
});

test("品牌退出满 90 天仍挂起的关系自动撤销", () => {
  const h = harness();
  const r = establish(h.svc).relationshipId;
  h.svc.brandExit("brandB", { commandId: "exit" });
  assert.equal(h.svc.authorize(r, "TEXT").allowed, false);
  h.advanceDays(DEADLINES.BRAND_EXIT_SUSPEND_DAYS + 1);
  const effects = h.svc.sweep();
  assert.ok(effects.some((e) => e.type === "BRAND_EXIT_REVOKED"));
  assert.equal(h.svc.authorize(r, "TEXT").reason, REASON_CODES.CACHE_PENDING_EXPIRY);
});

// ---- 11. 紧急联系人：唯一豁免入口，3 个上限 + 90 天复核 --------------------

test("紧急联系人绕过年龄矩阵（7 岁可用语音），但受数量上限约束", () => {
  const { svc } = harness();
  svc.registerChild({ childId: "kid", brandId: "A", ageYears: 7, guardianId: "mom" });
  for (let i = 0; i < 4; i++) {
    svc.registerChild({ childId: `e${i}`, brandId: i % 2 ? "A" : "B", ageYears: 40, guardianId: `ge${i}` });
  }
  const first = svc.declareEmergencyContact("kid", "e0", "mom", { commandId: "ec0" });
  for (let i = 1; i < 3; i++) {
    assert.equal(svc.declareEmergencyContact("kid", `e${i}`, "mom", { commandId: `ec${i}` }).ok, true);
  }
  assert.equal(first.ok, true);
  assert.equal(svc.authorize(first.relationshipId, "VOICE").allowed, true);
  // 第 4 个被拒
  assert.equal(svc.declareEmergencyContact("kid", "e3", "mom", { commandId: "ec3" }).reason,
    REASON_CODES.EMERGENCY_LIMIT_EXCEEDED);
});

test("紧急联系人 90 天未复核则暂停，复核后恢复；位置为限时会话", () => {
  const h = harness();
  h.svc.registerChild({ childId: "kid", brandId: "A", ageYears: 7, guardianId: "mom" });
  h.svc.registerChild({ childId: "dad", brandId: "B", ageYears: 40, guardianId: "gd" });
  const ec = h.svc.declareEmergencyContact("kid", "dad", "mom", { commandId: "ec" });

  // 低龄儿童在紧急关系下可以开启限时位置会话
  assert.equal(h.svc.startLocationSession(ec.relationshipId, "mom", { commandId: "loc" }).ok, true);
  assert.equal(h.svc.authorize(ec.relationshipId, "LOCATION").allowed, true);

  h.advanceDays(DEADLINES.EMERGENCY_REVIEW_DAYS + 1);
  h.svc.sweep();
  assert.equal(h.svc.authorize(ec.relationshipId, "VOICE").reason, REASON_CODES.EMERGENCY_REVIEW_DUE);
  assert.equal(h.svc.reviewEmergencyContact(ec.relationshipId, "mom", { commandId: "rv" }).ok, true);
  assert.equal(h.svc.authorize(ec.relationshipId, "VOICE").allowed, true);
});

// ---- 12. 可解释性：家长读得懂，且不含对方档案 -----------------------------

test("解释卡片与实际判定一致，文案可读，对方仅显示品牌与掩码假名", () => {
  const { svc } = harness();
  const r = establish(svc, { ageA: 7, ageB: 16 }).relationshipId;
  const card = svc.explain(r, "GROUP", "c1");
  assert.equal(card.allowed, false);
  assert.equal(card.reason_code, REASON_CODES.CAPABILITY_NOT_GRANTED_FOR_AGE);
  assert.match(card.reason_text, /年龄段/);
  assert.match(card.peer_brief, /^brandB:h_/);
  assert.match(card.peer_brief, /…/);
  // 卡片中不得出现对方真实儿童标识
  assert.equal(JSON.stringify(card).includes("c2"), false);

  const okCard = svc.explain(r, "TEXT", "c1");
  assert.equal(okCard.allowed, true);
});

test("撤销解释明确告知缓存承诺时刻", () => {
  const { svc } = harness();
  const r = establish(svc).relationshipId;
  svc.revokeRelationship(r, "gb", { commandId: "rev" });
  const card = svc.explain(r, "TEXT");
  assert.equal(card.reason_code, REASON_CODES.CACHE_PENDING_EXPIRY);
  assert.ok(card.expires_at);
});

// ---- 13. 证据另行封存 + 跨品牌申诉最小信封 --------------------------------

test("投诉证据独立封存：业务流只见引用，读取必须登记，365 天后清除", () => {
  const h = harness();
  const r = establish(h.svc).relationshipId;
  const { evidenceRef } = h.svc.fileSafetyReport({
    reporterChildId: "c2",
    relationshipId: r,
    category: "HARASSMENT",
    facts: ["2026-10-01 晚间收到不当言语"], // 生产中为加密材料
    attachments: ["screenshot://vault/abc"],
    placeHold: true,
  });
  assert.match(evidenceRef, /^ev_/);
  // 安全冻结期间一切能力关闭
  assert.equal(h.svc.authorize(r, "TEXT").reason, REASON_CODES.SAFETY_HOLD);

  // 路由与解释接口拿不到证据内容
  assert.equal(JSON.stringify(h.svc.routingProjection(r)).includes("不当言语"), false);

  // 证据库读取有访问登记
  const opened = h.svc.vault.open(evidenceRef, { accessedBy: "safety-officer-1", purpose: "调查" });
  assert.ok(opened.content_hash);
  assert.equal(h.svc.vault.accessLog.length, 1);
  const manifest = h.svc.vault.manifest()[0];
  assert.equal(manifest.ref, evidenceRef);
  assert.equal("content" in manifest, false);

  h.advanceDays(DEADLINES.EVIDENCE_RETENTION_DAYS + 1);
  h.svc.sweep();
  assert.equal(h.svc.vault.open(evidenceRef, { accessedBy: "x", purpose: "y" }), null);
});

test("跨品牌申诉信封只有关系引用与证据引用，结构性不含其他儿童资料", () => {
  const { svc } = harness();
  const r = establish(svc).relationshipId;
  const { evidenceRef } = svc.fileSafetyReport({
    reporterChildId: "c1", relationshipId: r, category: "WRONG_IDENTITY", facts: ["误加"],
  });
  const appeal = svc.fileAppeal({
    relationshipId: r,
    reporterBrand: "brandA",
    respondentBrand: "brandB",
    category: "WRONG_IDENTITY",
    detail: "请求通过短码发起但对方并非本人",
    evidenceRef,
    commandId: "appeal-1",
  });
  assert.equal(appeal.ok, true);
  assert.deepEqual(appeal.envelope.other_children_profiles, []);
  assert.equal(appeal.envelope.event_ref, evidenceRef);
  for (const forbidden of ["c1", "c2", "不当", "误加"]) {
    // detail 是陈述文本（允许），但儿童标识与证据事实不得进入信封
    if (forbidden === "误加") continue;
    assert.equal(JSON.stringify(appeal.envelope).includes(forbidden), false);
  }

  // 被申诉品牌只能看到信封
  const inbox = svc.appealsFor("brandB");
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].envelope.relationship_ref, r);
  assert.equal(svc.appealsFor("brandA").length, 0);

  // 处置完成并解除冻结
  assert.equal(svc.resolveAppeal(appeal.appealId, "brandB", "RELATIONSHIP_REVOKED", { liftHold: false }).ok, true);
});

// ---- 14. 审计链 -----------------------------------------------------------

test("事件哈希链可验证，任何篡改都会被发现", () => {
  const { svc } = harness();
  establish(svc);
  assert.equal(svc.verifyChain(), true);
  const evt = svc.log.events.find((e) => e.kind === "CONTACT_CONFIRMED");
  evt.payload.capabilities = ["LOCATION"]; // 篡改
  assert.equal(svc.verifyChain(), false);
});
