/**
 * Runner のエントリポイント。
 *
 * - 本番（Cloud Run Jobs）: 環境変数 TURN_ID などが渡されるので 1 ターン実行して終了する。
 * - ローカル開発: TURN_ID が無ければ HTTP サーバーとして起動し、POST /v1/jobs で
 *   ジョブを受け付ける（Cloud Run Jobs の代わり。1 つずつ順番に実行する）。
 */
import express from "express";
import { runJob, type JobParams } from "./job.js";

if (process.env.TURN_ID) {
  const params: JobParams = {
    callbackUrl: process.env.CALLBACK_URL!,
    sessionId: process.env.SESSION_ID!,
    turnId: process.env.TURN_ID,
    turnToken: process.env.TURN_TOKEN!,
  };
  runJob(params)
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
} else {
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  let queue: Promise<void> = Promise.resolve();
  let pending = 0;

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, pending });
  });

  app.post("/v1/jobs", (req, res) => {
    const p = req.body as JobParams;
    if (!p?.callbackUrl || !p.sessionId || !p.turnId || !p.turnToken) {
      res.status(400).json({ error: "callbackUrl, sessionId, turnId and turnToken are required" });
      return;
    }
    pending++;
    queue = queue
      .then(() => runJob(p))
      .catch((e) => console.error("job failed:", e))
      .finally(() => pending--);
    res.status(202).json({ accepted: true, pending });
  });

  const port = Number(process.env.PORT ?? 8081);
  app.listen(port, () => console.log(`runner (local job server) listening on :${port}`));
}
