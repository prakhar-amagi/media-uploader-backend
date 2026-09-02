import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";

import {
  SSOOIDCClient,
  RegisterClientCommand,
  StartDeviceAuthorizationCommand,
  CreateTokenCommand,
} from "@aws-sdk/client-sso-oidc";

import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { fromIni } from "@aws-sdk/credential-providers";

/* =========================================================
   Read the [profile <name>] section of ~/.aws/config to get
   sso_start_url / sso_region — the same values `aws configure
   sso --profile <name>` already wrote there. We don't ask the
   user to re-enter these; we read what's already configured.

   Handles both config formats AWS CLI produces:
   - Legacy: sso_start_url/sso_region directly under [profile x]
   - Modern (SSO sessions): [profile x] has `sso_session = Name`,
     and the actual sso_start_url/sso_region live under a
     separate [sso-session Name] block.
   ========================================================= */
function parseIniSections(content) {
  const sections = {};
  let currentSection = null;

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;

    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      sections[currentSection] = sections[currentSection] || {};
      continue;
    }

    if (currentSection && line.includes("=")) {
      const [key, ...rest] = line.split("=");
      sections[currentSection][key.trim()] = rest.join("=").trim();
    }
  }

  return sections;
}

function readSsoProfileConfig(profileName) {
  const configPath = path.join(os.homedir(), ".aws", "config");

  if (!fs.existsSync(configPath)) {
    throw new Error(
      `No ~/.aws/config found. Run "aws configure sso --profile ${profileName}" once from a terminal first.`
    );
  }

  const sections = parseIniSections(fs.readFileSync(configPath, "utf-8"));

  const profileSection =
    sections[`profile ${profileName}`] || sections[profileName];

  if (!profileSection) {
    throw new Error(
      `No profile "${profileName}" found in ~/.aws/config. Run "aws configure sso --profile ${profileName}" once from a terminal first.`
    );
  }

  let ssoStartUrl = profileSection.sso_start_url;
  let ssoRegion = profileSection.sso_region;
  let ssoSessionName = null;

  // Modern format: profile references a named [sso-session X] block
  // instead of embedding sso_start_url/sso_region directly. This also
  // changes the token cache filename convention (see writeSsoTokenCache).
  if (profileSection.sso_session) {
    ssoSessionName = profileSection.sso_session;
    const sessionSection = sections[`sso-session ${profileSection.sso_session}`];
    if (sessionSection) {
      ssoStartUrl = ssoStartUrl || sessionSection.sso_start_url;
      ssoRegion = ssoRegion || sessionSection.sso_region;
    }
  }

  if (!ssoStartUrl || !ssoRegion) {
    throw new Error(
      `Profile "${profileName}" in ~/.aws/config is missing sso_start_url/sso_region ` +
      `(checked both the profile section and its linked [sso-session] block, if any). ` +
      `Run "aws configure sso --profile ${profileName}" once from a terminal first.`
    );
  }

  return {
    ssoStartUrl,
    ssoRegion,
    ssoSessionName,
    accountId: profileSection.sso_account_id || null,
    roleName: profileSection.sso_role_name || null,
  };
}

/* =========================================================
   In-memory store of in-flight device-authorization attempts.
   Keyed by a sessionId handed to the browser — the actual
   clientId/clientSecret/deviceCode never leave the server.
   ========================================================= */
const pendingSessions = new Map();

function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [id, session] of pendingSessions) {
    if (session.expiresAt < now) pendingSessions.delete(id);
  }
}

/* =========================================================
   Step 1: start the device-authorization flow.
   Mirrors what `aws sso login` does: register a public OIDC
   client, then request a device code + user verification URL.
   ========================================================= */
export async function startDeviceAuthorization(profileName) {
  cleanupExpiredSessions();

  const { ssoStartUrl, ssoRegion, ssoSessionName } = readSsoProfileConfig(profileName);

  const oidc = new SSOOIDCClient({ region: ssoRegion });

  const registration = await oidc.send(
    new RegisterClientCommand({
      clientName: "media-uploader-backend-rca",
      clientType: "public",
    })
  );

  const deviceAuth = await oidc.send(
    new StartDeviceAuthorizationCommand({
      clientId: registration.clientId,
      clientSecret: registration.clientSecret,
      startUrl: ssoStartUrl,
    })
  );

  const sessionId = crypto.randomUUID();

  pendingSessions.set(sessionId, {
    profileName,
    ssoStartUrl,
    ssoRegion,
    ssoSessionName,
    clientId: registration.clientId,
    clientSecret: registration.clientSecret,
    clientSecretExpiresAt: registration.clientSecretExpiresAt,
    deviceCode: deviceAuth.deviceCode,
    interval: deviceAuth.interval || 5,
    expiresAt: Date.now() + (deviceAuth.expiresIn || 600) * 1000,
  });

  return {
    sessionId,
    userCode: deviceAuth.userCode,
    verificationUri: deviceAuth.verificationUri,
    verificationUriComplete: deviceAuth.verificationUriComplete,
    expiresIn: deviceAuth.expiresIn,
    interval: deviceAuth.interval || 5,
  };
}

/* =========================================================
   Step 2: poll for completion. The browser calls this every
   `interval` seconds. Once the user approves in the AWS tab,
   this succeeds and we write the token to the same cache file
   location the AWS CLI/SDK already read from.
   ========================================================= */
export async function pollDeviceAuthorization(sessionId) {
  const session = pendingSessions.get(sessionId);

  if (!session) {
    return { status: "expired", error: "Session not found or expired. Click Connect again." };
  }

  if (Date.now() > session.expiresAt) {
    pendingSessions.delete(sessionId);
    return { status: "expired", error: "Device code expired. Click Connect again." };
  }

  const oidc = new SSOOIDCClient({ region: session.ssoRegion });

  try {
    const token = await oidc.send(
      new CreateTokenCommand({
        clientId: session.clientId,
        clientSecret: session.clientSecret,
        deviceCode: session.deviceCode,
        grantType: "urn:ietf:params:oauth:grant-type:device_code",
      })
    );

    writeSsoTokenCache({
      ssoStartUrl: session.ssoStartUrl,
      ssoRegion: session.ssoRegion,
      ssoSessionName: session.ssoSessionName,
      accessToken: token.accessToken,
      expiresInSeconds: token.expiresIn,
      clientId: session.clientId,
      clientSecret: session.clientSecret,
      clientSecretExpiresAt: session.clientSecretExpiresAt,
    });

    pendingSessions.delete(sessionId);

    return { status: "complete" };
  } catch (error) {
    const name = error.name || "";

    if (name === "AuthorizationPendingException") {
      return { status: "pending" };
    }
    if (name === "SlowDownException") {
      session.interval += 5;
      return { status: "pending" };
    }
    if (name === "ExpiredTokenException") {
      pendingSessions.delete(sessionId);
      return { status: "expired", error: "Device code expired. Click Connect again." };
    }

    pendingSessions.delete(sessionId);
    return { status: "error", error: error.message || "Unknown SSO error" };
  }
}

/* =========================================================
   Write the SSO access token to ~/.aws/sso/cache/<hash>.json,
   the exact file the AWS CLI writes after `aws sso login` and
   that the SDK's fromIni()/fromSSO() credential providers read
   from automatically.

   IMPORTANT: the cache-key hash formula differs by config format:
   - Legacy (sso_start_url directly under [profile x]):
       key = sha1(startUrl)
   - Modern (profile has `sso_session = Name`, referencing a
     separate [sso-session Name] block):
       key = sha1(sessionName)   <-- NOT the start URL!
   Getting this wrong means the token writes successfully but
   credential resolution can never find it — the exact bug this
   fixes. Once the correct file exists, fromIni({ profile: X })
   just works — no other code changes needed.
   ========================================================= */
function writeSsoTokenCache({
  ssoStartUrl,
  ssoRegion,
  ssoSessionName,
  accessToken,
  expiresInSeconds,
  clientId,
  clientSecret,
  clientSecretExpiresAt,
}) {
  const cacheDir = path.join(os.homedir(), ".aws", "sso", "cache");
  fs.mkdirSync(cacheDir, { recursive: true });

  const cacheKeySource = ssoSessionName || ssoStartUrl;
  const cacheKey = crypto.createHash("sha1").update(cacheKeySource).digest("hex");
  const cacheFile = path.join(cacheDir, `${cacheKey}.json`);

  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000)
    .toISOString()
    .replace(/\.\d+Z$/, "Z"); // AWS CLI writes without milliseconds

  const registrationExpiresAt = clientSecretExpiresAt
    ? new Date(clientSecretExpiresAt * 1000).toISOString().replace(/\.\d+Z$/, "Z")
    : expiresAt;

  const cacheContent = {
    startUrl: ssoStartUrl,
    region: ssoRegion,
    accessToken,
    expiresAt,
    clientId,
    clientSecret,
    registrationExpiresAt,
    tokenType: "Bearer",
  };

  fs.writeFileSync(cacheFile, JSON.stringify(cacheContent, null, 2), { mode: 0o600 });
}

/* =========================================================
   Check whether Athena/AWS credentials currently resolve for
   a profile — used both to show connection status on page
   load and to gate the "Run RCA" button.
   ========================================================= */
export async function checkAwsConnection(profileName) {
  try {
    const { ssoRegion, accountId, roleName } = readSsoProfileConfig(profileName);

    const credentials = fromIni({ profile: profileName });
    const sts = new STSClient({ region: ssoRegion, credentials });

    const identity = await sts.send(new GetCallerIdentityCommand({}));

    return {
      connected: true,
      account: identity.Account,
      arn: identity.Arn,
      expectedAccountId: accountId,
      expectedRoleName: roleName,
      error: null,
      isSsoExpired: false,
    };
  } catch (error) {
    const isSsoExpired = /token is expired|sso session|aws sso login/i.test(error.message || "");
    return {
      connected: false,
      account: null,
      arn: null,
      error: error.message,
      isSsoExpired,
    };
  }
}
