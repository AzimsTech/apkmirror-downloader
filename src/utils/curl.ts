import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * APKMirror serves Cloudflare managed challenges to clients whose TLS
 * fingerprints look "non-browser" (Node/Bun fetch, plain curl from
 * datacenter IPs). Plain curl works from residential IPs; when it is
 * challenged we retry through Python's curl_cffi, which impersonates
 * the current Chrome TLS/HTTP2 fingerprint and is accepted even from
 * datacenter IPs (verified against GitHub Actions runners).
 */
export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const CURL = process.platform === "win32" ? "curl.exe" : "curl";
const PYTHON = process.platform === "win32" ? "python" : "python3";

const CFFI_SCRIPT = `
import sys
from curl_cffi import requests

url, out = sys.argv[1], sys.argv[2]
r = requests.get(url, impersonate="chrome", timeout=600, allow_redirects=True)
with open(out, "wb") as f:
    f.write(r.content)
print("%d\\t%s\\t%d" % (r.status_code, r.url, 1 if r.history else 0))
`;

const COMMON_ARGS = [
  "-sS",
  "-L",
  "--compressed",
  "-A",
  USER_AGENT,
  "-H",
  "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "-H",
  "Accept-Language: en-US,en;q=0.9",
  "--connect-timeout",
  "30",
  "--retry",
  "3",
  "--retry-delay",
  "2",
] as const;

const CHALLENGE_MARKERS = ["Just a moment", "Enable JavaScript and cookies"];

export type CurlMeta = {
  status: number;
  url: string;
  redirected: boolean;
};

function runCurl(url: string, outFile: string, maxTime: number) {
  return new Promise<CurlMeta>((resolve, reject) => {
    const child = spawn(CURL, [
      ...COMMON_ARGS,
      "--max-time",
      `${maxTime}`,
      "-o",
      outFile,
      "-w",
      "%{http_code}\t%{url_effective}\t%{num_redirects}",
      url,
    ]);

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => (stdout += chunk));
    child.stderr.on("data", chunk => (stderr += chunk));
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) {
        reject(new Error(`curl exited with code ${code}: ${stderr.trim()}`));
        return;
      }

      const [status, effectiveUrl, numRedirects] = stdout.trim().split("\t");
      resolve({
        status: Number(status),
        url: effectiveUrl,
        redirected: Number(numRedirects) > 0,
      });
    });
  });
}

function runCffi(url: string, outFile: string) {
  return new Promise<CurlMeta>((resolve, reject) => {
    const child = spawn(PYTHON, ["-c", CFFI_SCRIPT, url, outFile]);

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => (stdout += chunk));
    child.stderr.on("data", chunk => (stderr += chunk));
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) {
        reject(
          new Error(
            `curl_cffi helper exited with code ${code}: ${stderr.trim()}`,
          ),
        );
        return;
      }

      const [status, effectiveUrl, numRedirects] = stdout.trim().split("\t");
      resolve({
        status: Number(status),
        url: effectiveUrl,
        redirected: Number(numRedirects) > 0,
      });
    });
  });
}

let cffiCheck: Promise<boolean> | undefined;

function cffiAvailable() {
  cffiCheck ??= new Promise<boolean>(resolve => {
    const child = spawn(PYTHON, ["-c", "import curl_cffi"], {
      stdio: "ignore",
    });
    child.on("error", () => resolve(false));
    child.on("close", code => resolve(code === 0));
  });
  return cffiCheck;
}

function fileLooksLikeChallenge(path: string) {
  try {
    const fd = openSync(path, "r");
    const buf = Buffer.alloc(4096);
    const n = readSync(fd, buf, 0, buf.length, 0);
    closeSync(fd);
    const head = buf.subarray(0, n).toString("utf8");
    return CHALLENGE_MARKERS.some(marker => head.includes(marker));
  } catch {
    return false;
  }
}

function isChallengeStatus(status: number) {
  return status === 403 || status === 503;
}

async function fetchSmart(url: string, outFile: string, maxTime: number) {
  let meta = await runCurl(url, outFile, maxTime);

  const challenged =
    isChallengeStatus(meta.status) || fileLooksLikeChallenge(outFile);

  if (
    challenged &&
    !process.env.APKMD_DISABLE_CFFI &&
    (await cffiAvailable())
  ) {
    console.error(
      `[apkmd] Cloudflare challenge (HTTP ${meta.status}), retrying with Chrome impersonation...`,
    );
    meta = await runCffi(url, outFile);
  }

  return meta;
}

function makeTempPath() {
  return join(tmpdir(), `apkmd-${randomBytes(8).toString("hex")}`);
}

export async function curlText(url: string) {
  const tmp = makeTempPath();

  try {
    const meta = await fetchSmart(url, tmp, 120);
    if (meta.status !== 200) {
      throw new Error(`HTTP ${meta.status} for ${url}`);
    }

    const { readFile } = await import("node:fs/promises");
    const text = await readFile(tmp, "utf8");

    if (CHALLENGE_MARKERS.some(marker => text.includes(marker))) {
      throw new Error(
        "This page cannot be loaded without JavaScript and cookies enabled :(",
      );
    }

    return { ...meta, text };
  } finally {
    rmSync(tmp, { force: true });
  }
}

export async function curlDownload(url: string, dest: string) {
  const dir = dirname(dest);
  if (dir && dir !== "." && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  try {
    const meta = await fetchSmart(url, dest, 3600);
    if (meta.status !== 200) {
      throw new Error(`HTTP ${meta.status} while downloading ${url}`);
    }

    return meta;
  } catch (err) {
    rmSync(dest, { force: true });
    throw err;
  }
}
