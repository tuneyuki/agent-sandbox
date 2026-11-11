/**
 * パッケージ取得の設定（npm / pip / uv）。
 *
 * 本番では Runner はインターネットに出られないので、Artifact Registry の
 * リモートリポジトリ（npmjs / PyPI のプロキシ）を経由してパッケージを取る。
 * 認証は Runner の SA のアクセストークン（メタデータサーバーから取得）。
 *
 *   NPM_MIRROR_URL   例: https://asia-northeast1-npm.pkg.dev/PROJECT/npm-remote/
 *   PYPI_MIRROR_URL  例: https://asia-northeast1-python.pkg.dev/PROJECT/pypi-remote/simple/
 *
 * どちらも未設定なら公式レジストリを直接使う（ローカル開発・インターネット許可時）。
 */
import { writeFile, rm } from "node:fs/promises";
import path from "node:path";

const NPM_MIRROR_URL = process.env.NPM_MIRROR_URL;
const PYPI_MIRROR_URL = process.env.PYPI_MIRROR_URL;

async function metadataToken(): Promise<string> {
  const res = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } },
  );
  if (!res.ok) throw new Error(`metadata token: ${res.status}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

/**
 * ターン開始時に呼ぶ。エージェントに渡す追加の環境変数を返し、~/.npmrc を書く。
 * （トークンは 1 時間有効。ターンの上限より長い）
 */
export async function configurePackageMirrors(home: string): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  const npmrc = path.join(home, ".npmrc");
  await rm(npmrc, { force: true });
  if (!NPM_MIRROR_URL && !PYPI_MIRROR_URL) return env;

  const token = await metadataToken();

  if (NPM_MIRROR_URL) {
    const u = new URL(NPM_MIRROR_URL);
    const hostPath = `//${u.host}${u.pathname}`;
    // npm / pnpm / yarn(classic) が読む
    await writeFile(npmrc, `registry=${NPM_MIRROR_URL}\n${hostPath}:_authToken=${token}\nalways-auth=true\n`, {
      mode: 0o600,
    });
    env.NPM_CONFIG_REGISTRY = NPM_MIRROR_URL;
    env.COREPACK_NPM_REGISTRY = NPM_MIRROR_URL;
    env.COREPACK_NPM_TOKEN = token;
  }

  if (PYPI_MIRROR_URL) {
    const u = new URL(PYPI_MIRROR_URL);
    u.username = "oauth2accesstoken";
    u.password = token;
    env.PIP_INDEX_URL = u.toString();
    env.UV_DEFAULT_INDEX = u.toString();
    env.UV_INDEX_URL = u.toString();
  }
  return env;
}
