import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * APKMirror serves Cloudflare managed challenges to runtimes whose TLS
 * fingerprints look "non-browser" (Node/Bun fetch). curl's handshake is
 * still accepted, so all HTTP traffic is routed through it.
 */
export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const CURL = process.platform === "win32" ? "curl.exe" : "curl";

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

function makeTempPath() {
  return join(tmpdir(), `apkmd-${randomBytes(8).toString("hex")}`);
}

export async function curlText(url: string) {
  const tmp = makeTempPath();

  try {
    const meta = await runCurl(url, tmp, 120);
    if (meta.status !== 200) {
      throw new Error(`HTTP ${meta.status} for ${url}`);
    }

    const { readFile } = await import("node:fs/promises");
    const text = await readFile(tmp, "utf8");

    if (
      text.includes("Just a moment") ||
      text.includes("Enable JavaScript and cookies")
    ) {
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
    const meta = await runCurl(url, dest, 3600);
    if (meta.status !== 200) {
      throw new Error(`HTTP ${meta.status} while downloading ${url}`);
    }

    return meta;
  } catch (err) {
    rmSync(dest, { force: true });
    throw err;
  }
}
