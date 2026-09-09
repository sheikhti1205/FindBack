import { describe, expect, it } from "vitest";
import request from "supertest";
import { app, loginAs, registerAgent } from "./helpers.js";

describe("auth + verification", () => {
  it("registers a user and returns a JWT", async () => {
    const agent = await registerAgent();
    expect(agent.token).toBeTruthy();
    expect(agent.user.emailVerified).toBe(false);
    expect(agent.user.phoneVerified).toBe(false);
  });

  it("rejects duplicate username and email", async () => {
    const payload = {
      username: "dupl_test_1",
      email: "dupl1@example.com",
      phone: "01820000001",
      password: "password123",
    };
    await request(app).post("/auth/register").send(payload).expect(201);
    await request(app)
      .post("/auth/register")
      .send({ ...payload, email: "other1@example.com", phone: "01820000002" })
      .expect(409);
    await request(app)
      .post("/auth/register")
      .send({ ...payload, username: "dupl_test_2", phone: "01820000003" })
      .expect(409);
  });

  it("rejects weak passwords", async () => {
    await request(app)
      .post("/auth/register")
      .send({
        username: "weakpass",
        email: "weak@example.com",
        phone: "01820000009",
        password: "short",
      })
      .expect(400);
  });

  it("logs in with username or email", async () => {
    const agent = await registerAgent("loginme");
    const byName = await request(app)
      .post("/auth/login")
      .send({ identifier: agent.user.username, password: "password123" });
    expect(byName.status).toBe(200);
    expect(byName.body.token).toBeTruthy();

    const byEmail = await request(app)
      .post("/auth/login")
      .send({ identifier: agent.user.email, password: "password123" });
    expect(byEmail.status).toBe(200);

    await request(app)
      .post("/auth/login")
      .send({ identifier: agent.user.username, password: "wrong" })
      .expect(401);
  });

  it("checks username availability live against the database", async () => {
    // seeded user
    const res = await request(app).get("/users/check-username").query({ username: "rafi_cu" });
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);

    const free = await request(app)
      .get("/users/check-username")
      .query({ username: "definitely_free_name" });
    expect(free.status).toBe(200);
    expect(free.body.available).toBe(true);
  });

  it("sends + verifies email and phone in dev mode", async () => {
    const agent = await registerAgent("verify_me");

    const emailSend = await request(app)
      .post("/verification/EMAIL/send")
      .set("Authorization", `Bearer ${agent.token}`)
      .expect(200);
    const emailCode = emailSend.body.devCode as string;
    expect(emailCode).toMatch(/^\d{6}$/);

    await request(app)
      .post("/verification/EMAIL/verify")
      .set("Authorization", `Bearer ${agent.token}`)
      .send({ channel: "EMAIL", code: "000000" })
      .expect(400);

    const ok = await request(app)
      .post("/verification/EMAIL/verify")
      .set("Authorization", `Bearer ${agent.token}`)
      .send({ channel: "EMAIL", code: emailCode })
      .expect(200);
    expect(ok.body.emailVerified).toBe(true);

    const phoneSend = await request(app)
      .post("/verification/PHONE/send")
      .set("Authorization", `Bearer ${agent.token}`)
      .expect(200);
    await request(app)
      .post("/verification/PHONE/verify")
      .set("Authorization", `Bearer ${agent.token}`)
      .send({ channel: "PHONE", code: phoneSend.body.devCode })
      .expect(200);
  });

  it("requires auth for verification endpoints", async () => {
    await request(app).post("/verification/EMAIL/send").expect(401);
  });

  it("seeded demo user can log in", async () => {
    const token = await loginAs("rafi_cu");
    expect(token).toBeTruthy();
    const me = await request(app).get("/auth/me").set("Authorization", `Bearer ${token}`);
    expect(me.status).toBe(200);
  });
});
