import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";
import { ChildContactFederation } from "../src/federation_service.js";
import { EvidenceVault } from "../src/evidence_vault.js";
import {
  CAPABILITIES,
  MINIMAL_CONTACT_FIELDS,
  REASON_CODES,
  validateEvent,
} from "../src/domain.js";
import { DURATIONS_MS, sharedCapabilities } from "../src/policy.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// 可控时钟的服务装配。
function makeService() {
  let t = Date.parse("2026-09-20T09:00:00+08:00");
  const now = () => t;
  const vault = new EvidenceVault({ now });
  const service = new ChildContactFederation({ now, vault });
  return {
    service,
    vault,
    advance: (ms) => {
      t += ms;
    },
    at: () => t,
  };
}

// 两个品牌、两个孩子（默认都 12-15）、各自一位监护人。
function seedWorld({ ageA = "12-15", ageB = "12-15" } = {}) {
  const world = makeService();
  const { service } = world;
  service.enrollBrand("brand-x");
  service.enrollBrand("brand-y");
  service.enrollChild({ childId: "kid-a", brandId: "brand-x", ageBand: ageA, guardianIds: ["g-a"], displayLabel: "小明" });
  service.enrollChild({ childId: "kid-b", brandId: "brand-y", ageBand: ageB, guardianIds: ["g-b"], displayLabel: "小红" });
  return world;
}

function issueProof(service, kind = "FACE_TO_FACE_SHORT_CODE") {
  const issuedBy =
    kind === "SCHOOL_ATTESTATION"
      ? { schoolId: "school-1" }
      : kind === "GUARDIAN_REFERENCE"
        ? { guardianId: "g-a" }
        : { guardianId: "g-a" };
  return service.issueIntroProof({ kind, childIdA: "kid-a", childIdB: "kid-b", issuedBy });
}

// 完成标准建立流程，返回关系 id。
function establish(service, { idempotencyKey = "watch-1" } = {}) {
  const proof = issueProof(service);
  const req = service.requestFriend({ fromChildId: "kid-a", introCode: proof.code, idempotencyKey });
  const id = req.relationshipId;
  service.childConfirm({ relationshipId: id, childId: "kid-a" });
  service.childConfirm({ relationshipId: id, childId: "kid-b" });
  service.guardianConsent({ relationshipId: id, guardianId: "g-a", decision: true });
  service.guardianConsent({ relationshipId: id, guardianId: "g-b", decision: true });
  return id;
}

describe("领域资料", () => {
  test("样例符合领域约定", async () => {
    const record = JSON.parse(await readFile(new URL("../data/sample.json", import.meta.url), "utf8"));
    assert.deepEqual(validateEvent(record), []);
  });

  test("能力与理由码均在已知集合内", () => {
    assert.deepEqual(sharedCapabilities("8-11", "12-15"), ["TEXT"]);
    assert.deepEqual(sharedCapabilities("0-7", "16-17"), []);
    assert.ok(sharedCapabilities("12-15", "16-17").includes("LOCATION"));
    for (const code of Object.values(REASON_CODES)) {
      assert.ok(CAPABILITIES !== undefined); // 引用以确保领域模块完整加载
      assert.equal(typeof code, "string");
    }
  });

  test("跨品牌联系人只有最少标识白名单", () => {
    assert.deepEqual([...MINIMAL_CONTACT_FIELDS].sort(), [
      "age_band",
      "brand_id",
      "display_label",
      "federation_pseudonym",
      "intro_ref",
    ]);
  });
});

describe("建立联系：一次相识 + 双向确认 + 双方监护同意", () => {
  test("四重门齐备才成立，能力按双方年龄段交集开放", () => {
    const { service } = seedWorld({ ageA: "8-11", ageB: "12-15" });
    const proof = issueProof(service);
    const req = service.requestFriend({ fromChildId: "kid-a", introCode: proof.code, idempotencyKey: "k1" });
    const id = req.relationshipId;

    let view = service.explain(id);
    assert.equal(view.state, "PENDING");
    assert.equal(view.allowed, false);

    service.childConfirm({ relationshipId: id, childId: "kid-a" });
    view = service.explain(id);
    assert.ok(view.reasons.some((r) => r.code === REASON_CODES.PEER_CONFIRMATION_REQUIRED));

    service.childConfirm({ relationshipId: id, childId: "kid-b" });
    view = service.explain(id);
    assert.ok(view.reasons.some((r) => r.code === REASON_CODES.GUARDIAN_CONSENT_REQUIRED));

    service.guardianConsent({ relationshipId: id, guardianId: "g-a", decision: true });
    assert.equal(service.explain(id).state, "PENDING"); // 还缺对方监护人

    service.guardianConsent({ relationshipId: id, guardianId: "g-b", decision: true });
    view = service.explain(id);
    assert.equal(view.state, "ACTIVE");
    assert.equal(view.allowed, true);
    assert.deepEqual(view.grantedCapabilities, ["TEXT"]); // 低龄一方决定上限
    assert.match(view.summary, /被允许/);
    assert.match(view.summary, /文字/);
  });

  test("没有相识凭证不能加友；平台不提供陌生人搜索通路", () => {
    const { service } = seedWorld();
    const decision = service.requestFriend({ fromChildId: "kid-a", introCode: "guess-000000", idempotencyKey: "k2" });
    assert.equal(decision.allowed, false);
    assert.equal(decision.reasons[0].code, REASON_CODES.INTRO_REQUIRED);
    // 服务表面上不存在任何按姓名/账号检索其他儿童的方法。
    assert.equal(typeof service.searchChildren, "undefined");
    assert.equal(typeof service.directoryLookup, "undefined");
  });

  test("相识凭证一次性：重复使用被拒", () => {
    const { service } = seedWorld();
    const proof = issueProof(service);
    const first = service.requestFriend({ fromChildId: "kid-a", introCode: proof.code, idempotencyKey: "k3" });
    assert.equal(first.status, "CREATED");
    const second = service.requestFriend({ fromChildId: "kid-a", introCode: proof.code, idempotencyKey: "k4" });
    assert.equal(second.allowed, false);
    assert.equal(second.reasons[0].code, REASON_CODES.INTRO_ALREADY_USED);
  });

  test("面对面短码 10 分钟过期；学校证明 30 天有效", () => {
    const world = seedWorld();
    const { service, advance } = world;
    const shortCode = issueProof(service, "FACE_TO_FACE_SHORT_CODE");
    advance(11 * 60 * 1000);
    const expired = service.requestFriend({ fromChildId: "kid-a", introCode: shortCode.code, idempotencyKey: "k5" });
    assert.equal(expired.reasons[0].code, REASON_CODES.INTRO_EXPIRED);

    const school = issueProof(service, "SCHOOL_ATTESTATION");
    advance(29 * DAY);
    const stillValid = service.requestFriend({ fromChildId: "kid-a", introCode: school.code, idempotencyKey: "k6" });
    assert.equal(stillValid.status, "CREATED");

    advance(2 * DAY);
    // 学校证明在请求窗口内使用过，关系仍受 7 天请求期限约束。
    const view = service.explain(stillValid.relationshipId);
    assert.equal(view.state, "PENDING");
  });

  test("加友请求 7 天内未完成自动失效", () => {
    const { service, advance } = seedWorld();
    const proof = issueProof(service);
    const req = service.requestFriend({ fromChildId: "kid-a", introCode: proof.code, idempotencyKey: "k7" });
    advance(7 * DAY + 1);
    service.childConfirm({ relationshipId: req.relationshipId, childId: "kid-a" });
    const view = service.explain(req.relationshipId);
    assert.equal(view.state, "TERMINATED");
    assert.equal(view.reasons[0].code, REASON_CODES.REQUEST_EXPIRED);
  });
});

describe("离线重发的幂等性", () => {
  test("同一幂等键重发永远返回同一关系，不产生第二个关系或第二张凭证核销", () => {
    const { service } = seedWorld();
    const proof = issueProof(service);
    const first = service.requestFriend({ fromChildId: "kid-a", introCode: proof.code, idempotencyKey: "watch-offline-9" });
    // 手表离线期间多次重发同一请求。
    for (let i = 0; i < 5; i++) {
      const again = service.requestFriend({ fromChildId: "kid-a", introCode: proof.code, idempotencyKey: "watch-offline-9" });
      assert.equal(again.relationshipId, first.relationshipId);
      assert.equal(again.status, "DUPLICATE_RESEND");
    }
    const requestedEvents = service.events().filter((e) => e.kind === "FRIEND_REQUESTED");
    assert.equal(requestedEvents.length, 1);

    // 流程继续走完，仍然只有一条关系。
    const id = first.relationshipId;
    service.childConfirm({ relationshipId: id, childId: "kid-a" });
    service.childConfirm({ relationshipId: id, childId: "kid-b" });
    service.guardianConsent({ relationshipId: id, guardianId: "g-a" });
    service.guardianConsent({ relationshipId: id, guardianId: "g-b" });
    assert.equal(service.explain(id).state, "ACTIVE");
  });

  test("不带幂等键的并发重复请求也被同一对关系索引合并", () => {
    const { service } = seedWorld();
    const p1 = issueProof(service);
    const p2 = issueProof(service);
    const r1 = service.requestFriend({ fromChildId: "kid-a", introCode: p1.code });
    const r2 = service.requestFriend({ fromChildId: "kid-b", introCode: p2.code });
    assert.equal(r1.relationshipId, r2.relationshipId);
    assert.equal(r2.status, "ALREADY_PENDING_OR_ACTIVE");
  });
});

describe("年龄分级能力", () => {
  test("8-11 岁只有文字，语音/位置/群组均被阻断并给出可读理由", () => {
    const { service } = seedWorld({ ageA: "8-11", ageB: "8-11" });
    const id = establish(service);
    for (const cap of ["VOICE", "LOCATION", "GROUP"]) {
      const d = service.canUseCapability({ relationshipId: id, childId: "kid-a", capability: cap });
      assert.equal(d.allowed, false, cap);
      assert.equal(d.reasons[0].code, REASON_CODES.AGE_GATE_BLOCKED, cap);
    }
    assert.equal(service.canUseCapability({ relationshipId: id, childId: "kid-a", capability: "TEXT" }).allowed, true);
  });

  test("位置分享只有逐次限时会话，最长 60 分钟，到期自动关闭", () => {
    const world = seedWorld();
    const { service, advance } = world;
    const id = establish(service);
    // 没有会话时不能取位置。
    assert.equal(
      service.canUseCapability({ relationshipId: id, childId: "kid-a", capability: "LOCATION" }).reasons[0].code,
      REASON_CODES.LOCATION_SESSION_REQUIRED,
    );
    const session = service.startLocationSession({ relationshipId: id, childId: "kid-a", ttlMs: 2 * HOUR });
    // 请求 2 小时也被截到 60 分钟上限。
    assert.equal(session.endsAt, world.at() + DURATIONS_MS.LOCATION_SESSION_TTL);
    assert.equal(
      service.canUseCapability({ relationshipId: id, childId: "kid-a", capability: "LOCATION" }).allowed,
      true,
    );
    advance(61 * 60 * 1000);
    assert.equal(
      service.canUseCapability({ relationshipId: id, childId: "kid-a", capability: "LOCATION" }).reasons[0].code,
      REASON_CODES.LOCATION_SESSION_REQUIRED,
    );
  });
});

describe("撤销与缓存失效承诺", () => {
  test("监护人撤回同意立即中断关系，并下发 24 小时缓存失效指令、逐品牌收回执", () => {
    const world = seedWorld();
    const { service, advance } = world;
    const id = establish(service);
    service.guardianConsent({ relationshipId: id, guardianId: "g-b", decision: false });
    const view = service.explain(id);
    assert.equal(view.state, "REVOKED");
    assert.equal(view.reasons[0].code, REASON_CODES.GUARDIAN_CONSENT_WITHDRAWN);

    const status = service.cacheStatus(id);
    assert.equal(status.length, 1);
    assert.deepEqual([...status[0].pendingBrands].sort(), ["brand-x", "brand-y"]);
    assert.equal(status[0].deadline, world.at() + DURATIONS_MS.CACHE_EXPIRY_AFTER_REVOCATION);

    service.ackCacheInvalidation({ relationshipId: id, directiveId: status[0].directiveId, brandId: "brand-x" });
    let after = service.cacheStatus(id)[0];
    assert.deepEqual(after.pendingBrands, ["brand-y"]);
    assert.equal(after.overdue, false);

    advance(25 * HOUR);
    service.sweepTimeouts();
    after = service.cacheStatus(id)[0];
    assert.equal(after.overdue, true, "未按时回执必须被标记逾期，不能默认已失效");
  });

  test("撤销后联系人最小视图清空，撤销释放成对索引，可凭新凭证重新建立", () => {
    const { service } = seedWorld();
    const id = establish(service);
    service.revokeRelationship({ relationshipId: id, guardianId: "g-a" });
    const cleared = service.minimalContactView({ relationshipId: id, viewerChildId: "kid-a" });
    assert.equal(cleared.federation_pseudonym, null);

    const proof = issueProof(service);
    const again = service.requestFriend({ fromChildId: "kid-a", introCode: proof.code, idempotencyKey: "k-re" });
    assert.notEqual(again.relationshipId, id);
  });
});

describe("设备换绑", () => {
  test("换绑期间关系挂起但不删除，完成后连续恢复", () => {
    const { service } = seedWorld();
    const id = establish(service);
    const { deadline } = service.startDeviceRebind({ childId: "kid-a", newDeviceRef: "watch-new", requestedByGuardianId: "g-a" });
    assert.ok(deadline > 0);
    assert.equal(service.explain(id).state, "SUSPENDED");
    assert.equal(
      service.canUseCapability({ relationshipId: id, childId: "kid-b", capability: "TEXT" }).reasons[0].code,
      REASON_CODES.DEVICE_REBIND_PENDING,
    );
    service.completeDeviceRebind({ childId: "kid-a", newDeviceRef: "watch-new" });
    assert.equal(service.explain(id).state, "ACTIVE");
  });

  test("换绑 15 天逾期：申请失效，沿用旧设备绑定并恢复关系", () => {
    const { service, advance } = seedWorld();
    const id = establish(service);
    service.startDeviceRebind({ childId: "kid-a", newDeviceRef: "watch-new", requestedByGuardianId: "g-a" });
    advance(16 * DAY);
    const changes = service.sweepTimeouts();
    assert.ok(changes.some((c) => c.deviceRebind === "EXPIRED_RESUME_OLD_BINDING"));
    assert.equal(service.explain(id).state, "ACTIVE");
  });
});

describe("监护权改变", () => {
  test("30 天宽限期内新监护人重新确认，关系连续恢复，对方同意不受影响", () => {
    const { service } = seedWorld();
    const id = establish(service);
    const { deadline } = service.startGuardianshipTransfer({ childId: "kid-a", newGuardianIds: ["g-a2"], requestedByGuardianId: "g-a" });
    assert.ok(deadline > 0);
    const view = service.explain(id);
    assert.equal(view.state, "SUSPENDED");
    assert.equal(view.reasons[0].code, REASON_CODES.GUARDIANSHIP_GRACE_PENDING);
    assert.ok(view.deadlines.graceExpiresAt);

    // 旧监护人不再有管辖权。
    assert.throws(() => service.guardianConsent({ relationshipId: id, guardianId: "g-a", decision: true }));

    service.reaffirmGuardianship({ relationshipId: id, guardianId: "g-a2", consent: true });
    assert.equal(service.explain(id).state, "ACTIVE");
  });

  test("宽限期满未重新确认则终止；新监护人拒绝则立即撤销", () => {
    const world1 = seedWorld();
    const id1 = establish(world1.service);
    world1.service.startGuardianshipTransfer({ childId: "kid-a", newGuardianIds: ["g-a2"], requestedByGuardianId: "g-a" });
    world1.advance(31 * DAY);
    world1.service.sweepTimeouts();
    assert.equal(world1.service.explain(id1).state, "TERMINATED");
    assert.equal(world1.service.explain(id1).reasons[0].code, REASON_CODES.GUARDIANSHIP_GRACE_EXPIRED);

    const world2 = seedWorld();
    const id2 = establish(world2.service);
    world2.service.startGuardianshipTransfer({ childId: "kid-a", newGuardianIds: ["g-a2"], requestedByGuardianId: "g-a" });
    world2.service.reaffirmGuardianship({ relationshipId: id2, guardianId: "g-a2", consent: false });
    assert.equal(world2.service.explain(id2).state, "REVOKED");
  });
});

describe("账号跨品牌迁移", () => {
  test("迁移后 14 天内由未迁移一方重新确认+监护同意即恢复，并轮换假名、失效旧标识缓存", () => {
    const { service } = seedWorld();
    service.enrollBrand("brand-z");
    const id = establish(service);
    const before = service.minimalContactView({ relationshipId: id, viewerChildId: "kid-b" });
    const { newPseudonym, deadline } = service.startAccountMigration({
      childId: "kid-a",
      toBrandId: "brand-z",
      requestedByGuardianId: "g-a",
    });
    assert.ok(deadline > 0);
    assert.notEqual(newPseudonym, before.federation_pseudonym);
    assert.equal(service.explain(id).state, "SUSPENDED");
    assert.equal(service.explain(id).reasons[0].code, REASON_CODES.MIGRATION_PENDING_RECONSENT);

    // 迁移方孩子不需要重新确认。
    assert.throws(() => service.migrationChildReconfirm({ relationshipId: id, childId: "kid-a" }));
    service.migrationChildReconfirm({ relationshipId: id, childId: "kid-b" });
    assert.equal(service.explain(id).state, "SUSPENDED");
    service.migrationGuardianConsent({ relationshipId: id, guardianId: "g-b", decision: true });

    assert.equal(service.explain(id).state, "ACTIVE");
    const after = service.minimalContactView({ relationshipId: id, viewerChildId: "kid-b" });
    assert.equal(after.federation_pseudonym, newPseudonym);
    assert.equal(after.brand_id, "brand-z");
    const directives = service.cacheStatus(id);
    const rotation = directives.find((d) => d.type === "IDENTIFIER_ROTATION");
    assert.ok(rotation);
    assert.deepEqual([...rotation.pendingBrands].sort(), ["brand-x", "brand-y", "brand-z"]);
  });

  test("迁移重新确认窗口逾期，关系终止", () => {
    const { service, advance } = seedWorld();
    service.enrollBrand("brand-z");
    const id = establish(service);
    service.startAccountMigration({ childId: "kid-a", toBrandId: "brand-z", requestedByGuardianId: "g-a" });
    advance(15 * DAY);
    service.sweepTimeouts();
    assert.equal(service.explain(id).state, "TERMINATED");
    assert.equal(service.explain(id).reasons[0].code, REASON_CODES.MIGRATION_RECONSENT_EXPIRED);
  });

  test("不能迁移到未入盟品牌", () => {
    const { service } = seedWorld();
    const id = establish(service);
    const decision = service.startAccountMigration({ childId: "kid-a", toBrandId: "brand-ghost", requestedByGuardianId: "g-a" });
    assert.equal(decision.allowed, false);
    assert.equal(decision.reasons[0].code, REASON_CODES.BRAND_NOT_IN_FEDERATION);
    assert.equal(service.explain(id).state, "ACTIVE");
  });
});

describe("品牌退出联盟", () => {
  test("过渡期内不再建立新联系，既有联系保留；90 天过渡期结束后终止并要求删除标识", () => {
    const { service, advance } = seedWorld();
    const existing = establish(service);
    service.declareBrandExit("brand-y");

    const proof = issueProof(service);
    const blocked = service.requestFriend({ fromChildId: "kid-a", introCode: proof.code, idempotencyKey: "k-exit" });
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.reasons[0].code, REASON_CODES.BRAND_EXIT_NO_NEW);
    assert.equal(service.explain(existing).state, "ACTIVE");

    advance(91 * DAY);
    service.sweepTimeouts();
    const view = service.explain(existing);
    assert.equal(view.state, "TERMINATED");
    assert.equal(view.reasons[0].code, REASON_CODES.BRAND_EXIT_TERMINATED);
    assert.ok(service.cacheStatus(existing).length >= 1);
  });
});

describe("紧急联系人例外", () => {
  test("单方声明、限时 24 小时、仅文字语音、事后通知，到期自动关闭", () => {
    const { service, advance } = seedWorld();
    const { relationshipId, endsAt } = service.declareEmergencyContact({
      childId: "kid-a",
      remotePseudonym: "pseudo-stranger",
      remoteBrandId: "brand-y",
      reason: "孩子走失，需要联系现场工作人员",
      declaredByGuardianId: "g-a",
    });
    assert.ok(endsAt > 0);
    const view = service.explain(relationshipId);
    assert.equal(view.state, "EMERGENCY_LIMITED");
    assert.equal(view.reasons[0].code, REASON_CODES.EMERGENCY_ONLY);
    assert.equal(service.emergencySend({ relationshipId, capability: "VOICE" }).allowed, true);
    assert.equal(service.emergencySend({ relationshipId, capability: "TEXT" }).allowed, true);
    // 紧急通道不开放位置与群组。
    assert.equal(service.canUseCapability({ relationshipId, childId: "kid-a", capability: "LOCATION" }).allowed, false);

    const notices = service.markEmergencyNoticeDelivered({ relationshipId, brandId: "brand-y" });
    assert.equal(notices.every((n) => n.notified), true);

    advance(25 * HOUR);
    service.sweepTimeouts();
    assert.equal(service.explain(relationshipId).state, "TERMINATED");
    assert.equal(service.explain(relationshipId).reasons[0].code, REASON_CODES.EMERGENCY_EXPIRED);
  });

  test("紧急通道被投诉安全问题时立即终止，不留限时尾巴", () => {
    const { service } = seedWorld();
    const { relationshipId } = service.declareEmergencyContact({
      childId: "kid-a",
      remotePseudonym: "pseudo-stranger",
      remoteBrandId: "brand-y",
      reason: "紧急求助",
      declaredByGuardianId: "g-a",
    });
    service.fileComplaint({
      reporterGuardianId: "g-a",
      childId: "kid-a",
      relationshipId,
      category: "SAFETY_RISK",
      evidence: { note: "对方发送恐吓内容" },
    });
    assert.equal(service.explain(relationshipId).state, "TERMINATED");
  });
});

describe("跨品牌申诉与证据另行封存", () => {
  test("仅凭对方假名与品牌即可申诉，接口不接受也不回传其他儿童资料", () => {
    const { service } = seedWorld();
    const filed = service.fileComplaint({
      reporterGuardianId: "g-a",
      childId: "kid-a",
      aboutPseudonym: "pseudo-unknown",
      aboutBrandId: "brand-y",
      category: "HARASSMENT",
    });
    assert.deepEqual(Object.keys(filed.about).sort(), ["brand_id", "federation_pseudonym"]);
    const status = service.complaintStatus(filed.complaintRef, "g-a");
    assert.equal(status.status, "OPEN");
    assert.ok(status.deadline > filed.complaintRef.length);
    for (const key of Object.keys(status)) {
      assert.ok(!["name", "real_name", "school", "birthdate", "device_sn"].includes(key));
    }
    // 其他监护人看不到该申诉。
    assert.throws(() => service.complaintStatus(filed.complaintRef, "g-b"));
  });

  test("安全投诉期间关系挂起；成立则撤销，不成立则恢复", () => {
    const { service } = seedWorld();
    const id = establish(service);
    const c1 = service.fileComplaint({ reporterGuardianId: "g-b", childId: "kid-b", relationshipId: id, category: "HARASSMENT" });
    assert.equal(service.explain(id).state, "SUSPENDED");
    assert.equal(service.explain(id).reasons[0].code, REASON_CODES.COMPLAINT_UNDER_REVIEW);
    service.resolveComplaint(c1.complaintRef, { outcome: "DISMISSED", note: "未发现违规" });
    assert.equal(service.explain(id).state, "ACTIVE");

    const c2 = service.fileComplaint({ reporterGuardianId: "g-b", childId: "kid-b", relationshipId: id, category: "SAFETY_RISK" });
    service.resolveComplaint(c2.complaintRef, { outcome: "UPHELD" });
    assert.equal(service.explain(id).state, "REVOKED");
  });

  test("证据另行封存：目的与品牌受限、全程访问登记、到期销毁", () => {
    const world = makeService();
    const { vault, advance } = world;
    const sealed = vault.seal({
      complaintRef: "cmp-x",
      brandId: "brand-x",
      content: { transcript: "仅限调查使用的材料" },
      purpose: "COMPLAINT_INVESTIGATION",
    });
    // 其他品牌即使拿到 evidenceId 也读不到。
    assert.equal(vault.get(sealed.evidenceId, { brandId: "brand-y", purpose: "COMPLAINT_INVESTIGATION", actor: "ops-y" }), null);
    // 目的不符也读不到。
    assert.equal(vault.get(sealed.evidenceId, { brandId: "brand-x", purpose: "AD_PROFILING", actor: "ad-tech" }), null);
    const record = vault.get(sealed.evidenceId, { brandId: "brand-x", purpose: "COMPLAINT_INVESTIGATION", actor: "safety-x" });
    assert.ok(record);
    const log = vault.accessLog();
    assert.equal(log.length, 3);
    assert.equal(log[0].allowed, false);
    assert.equal(log[2].actor, "safety-x");

    // 协作列表只给元数据。
    const meta = vault.listForComplaint("cmp-x");
    assert.equal(meta.length, 1);
    assert.equal(meta[0].content, undefined);

    advance(181 * DAY);
    const purged = vault.purgeExpired();
    assert.deepEqual(purged, [sealed.evidenceId]);
    assert.equal(vault.get(sealed.evidenceId, { brandId: "brand-x", purpose: "COMPLAINT_INVESTIGATION", actor: "safety-x" }), null);
  });

  test("提交投诉时自动封存台账摘要与家长提交材料", () => {
    const { service, vault } = seedWorld();
    const id = establish(service);
    const filed = service.fileComplaint({
      reporterGuardianId: "g-a",
      childId: "kid-a",
      relationshipId: id,
      category: "DATA_REQUEST",
      evidence: { request: "请说明跨品牌交换了哪些标识" },
    });
    const meta = vault.listForComplaint(filed.complaintRef);
    assert.equal(meta.length, 1);
    const record = vault.get(meta[0].evidenceId, { brandId: "brand-x", purpose: "COMPLAINT_INVESTIGATION", actor: "dpo" });
    assert.ok(record.content.excerpt.events.some((e) => e.kind === "CONTACT_CONFIRMED"));
    assert.equal(record.content.supplied.request, "请说明跨品牌交换了哪些标识");
    // DATA_REQUEST 不挂起正常联系。
    assert.equal(service.explain(id).state, "ACTIVE");
  });
});

describe("家长可读解释与最小标识视图", () => {
  test("解释包含状态、中文理由、期限与逐项能力说明", () => {
    const { service } = seedWorld();
    const proof = issueProof(service);
    const req = service.requestFriend({ fromChildId: "kid-a", introCode: proof.code, idempotencyKey: "k-explain" });
    const pending = service.explain(req.relationshipId);
    assert.match(pending.summary, /尚未成立/);
    assert.match(pending.summary, /面对面短码/);
    assert.ok(pending.capabilityReport.every((c) => typeof c.reason === "string" || c.reason === null));

    const id = establish(service);
    const active = service.explain(id);
    assert.match(active.summary, /被允许/);
    assert.ok(active.capabilityReport.find((c) => c.capability === "VOICE").allowed);
  });

  test("最小标识视图不含真实姓名、生日、设备号等字段", () => {
    const { service } = seedWorld();
    const id = establish(service);
    const view = service.minimalContactView({ relationshipId: id, viewerChildId: "kid-a" });
    for (const key of Object.keys(view)) {
      if (key === "state") continue;
      assert.ok(MINIMAL_CONTACT_FIELDS.includes(key), `意外字段 ${key}`);
    }
    assert.equal(view.brand_id, "brand-y");
    assert.equal(view.age_band, "12-15"); // 只有粗粒度年龄段
    assert.equal(view.display_label, "小红");
  });
});
