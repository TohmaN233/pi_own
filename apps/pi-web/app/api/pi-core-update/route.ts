import { NextResponse } from "next/server";
import type { AppUpdateResponse, PiCoreInstallResponse } from "@/lib/api-types";
import {
  getPiCoreReleaseUrl,
  installPiCoreUpdate,
  isNewerStableVersion,
  locatePiWebPackageDirectory,
  readPiCoreDependencyVersion,
} from "@/lib/pi-core-update";
import { hasJsonContentType, isApiRequestAllowed, isApiRequestLoopback } from "@/lib/request-security";

export const dynamic = "force-dynamic";

const LATEST_PI_VERSION_URL = "https://pi.dev/api/latest-version";
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;
const SKIP_VERSION_CHECK = process.env.PI_WEB_SKIP_VERSION_CHECK === "1" || Boolean(process.env.PI_SKIP_VERSION_CHECK);

interface PiCoreUpdateCache {
  value?: AppUpdateResponse;
  expiresAt: number;
  inFlight?: Promise<AppUpdateResponse>;
}

declare global {
  var __piWebPiCoreUpdateCache: PiCoreUpdateCache | undefined;
  var __piWebPiCoreInstallInFlight: Promise<PiCoreInstallResponse> | undefined;
}

function getCache(): PiCoreUpdateCache {
  return globalThis.__piWebPiCoreUpdateCache ??= { expiresAt: 0 };
}

async function fetchLatestVersion(currentVersion: string): Promise<AppUpdateResponse> {
  const response = await fetch(LATEST_PI_VERSION_URL, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`pi.dev returned HTTP ${response.status}`);

  const body = await response.json() as { version?: unknown };
  const latestVersion = typeof body.version === "string" ? body.version : "";
  const releaseUrl = getPiCoreReleaseUrl(latestVersion);
  if (!releaseUrl) throw new Error("pi.dev returned an invalid Pi core version");

  return {
    currentVersion,
    latestVersion,
    updateAvailable: isNewerStableVersion(latestVersion, currentVersion),
    releaseUrl,
  };
}

async function loadUpdateStatus(currentVersion: string, refresh = false): Promise<AppUpdateResponse> {
  const cache = getCache();
  if (!refresh && cache.value?.currentVersion === currentVersion && cache.expiresAt > Date.now()) return cache.value;
  if (!cache.inFlight) {
    cache.inFlight = fetchLatestVersion(currentVersion).then((value) => {
      cache.value = value;
      cache.expiresAt = Date.now() + CACHE_TTL_MS;
      return value;
    }).finally(() => {
      cache.inFlight = undefined;
    });
  }
  return await cache.inFlight;
}

function currentVersion(): { appDirectory: string; version: string } {
  const appDirectory = locatePiWebPackageDirectory();
  return { appDirectory, version: readPiCoreDependencyVersion(appDirectory) };
}

export async function GET(request: Request) {
  try {
    const current = currentVersion();
    if (SKIP_VERSION_CHECK) {
      return NextResponse.json({
        currentVersion: current.version,
        latestVersion: current.version,
        updateAvailable: false,
        releaseUrl: "",
      } satisfies AppUpdateResponse);
    }
    const refresh = new URL(request.url).searchParams.get("refresh") === "1";
    return NextResponse.json(await loadUpdateStatus(current.version, refresh));
  } catch (error) {
    console.warn("[pi-web] Pi core update check failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}

export async function POST(request: Request) {
  if (!isApiRequestAllowed(request) || !isApiRequestLoopback(request)) {
    return NextResponse.json({ error: "Pi core updates are allowed only from this computer" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Expected application/json" }, { status: 415 });
  }
  if (SKIP_VERSION_CHECK) {
    return NextResponse.json({ error: "Pi core updates are disabled by configuration" }, { status: 403 });
  }
  if (globalThis.__piWebPiCoreInstallInFlight) {
    return NextResponse.json({ error: "A Pi core update is already running" }, { status: 409 });
  }

  try {
    const body = await request.json() as { version?: unknown };
    const current = currentVersion();
    const status = await loadUpdateStatus(current.version, true);
    if (typeof body.version !== "string" || body.version !== status.latestVersion) {
      return NextResponse.json({
        error: `Requested Pi version does not match the current stable release (${status.latestVersion})`,
      }, { status: 409 });
    }
    const installing = installPiCoreUpdate({
      appDirectory: current.appDirectory,
      version: status.latestVersion,
    });
    globalThis.__piWebPiCoreInstallInFlight = installing;
    const result = await installing;
    delete globalThis.__piWebPiCoreUpdateCache;
    return NextResponse.json(result satisfies PiCoreInstallResponse);
  } catch (error) {
    console.error("[pi-web] Pi core update failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  } finally {
    globalThis.__piWebPiCoreInstallInFlight = undefined;
  }
}
