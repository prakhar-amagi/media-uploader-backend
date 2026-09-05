/**
 * auth-guard.js — include this FIRST in every protected HTML page.
 *
 * Two layers of protection:
 *
 * 1. Page-load check: decode the JWT from localStorage and check its
 *    expiry time (the `exp` claim is a Unix timestamp). If the token
 *    is missing or expired, redirect to login immediately — before
 *    any page content or API calls run.
 *
 * 2. Fetch interceptor: wraps window.fetch so that any API call that
 *    returns HTTP 401 (token expired server-side, or revoked) also
 *    redirects to login, regardless of what the page itself does with
 *    the response. This is the safety net for tokens that expire
 *    mid-session while the page is already open.
 */

(function () {
  const LOGIN_PAGE = "/login.html";
  const PUBLIC_PAGES = [
    "/login.html",
    "/forgot.html",
    "/reset-password.html",
    "/set-password.html",
  ];

  // Don't run the guard on public pages (login, forgot password, etc.)
  const currentPath = window.location.pathname;
  if (PUBLIC_PAGES.some((p) => currentPath.endsWith(p))) return;

  // ── Helpers ──────────────────────────────────────────────────────

  function getToken() {
    return localStorage.getItem("token");
  }

  function isTokenExpired(token) {
    try {
      // JWT is three base64url segments separated by dots.
      // The payload (middle segment) contains the `exp` claim.
      const payload = JSON.parse(
        atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))
      );
      if (!payload.exp) return false; // no expiry = never expires

      // exp is a Unix timestamp in seconds; Date.now() is milliseconds.
      // Subtract a 30-second buffer so we catch tokens about to expire.
      return Date.now() >= (payload.exp - 30) * 1000;
    } catch {
      // If we can't decode it at all, treat it as expired.
      return true;
    }
  }

  function redirectToLogin() {
    localStorage.clear();
    // Preserve the page they were trying to reach so we can redirect
    // back after login (optional — ignored if login page doesn't use it).
    const returnTo = window.location.pathname + window.location.search;
    if (returnTo && returnTo !== "/" && !returnTo.includes("login")) {
      sessionStorage.setItem("loginRedirect", returnTo);
    }
    window.location.href = LOGIN_PAGE;
  }

  // ── Layer 1: check on page load ───────────────────────────────────

  const token = getToken();

  if (!token || isTokenExpired(token)) {
    redirectToLogin();
    // Stop all further script execution on this page load.
    // (The redirect is async so we need to throw to prevent the rest
    // of the page's inline scripts from running.)
    throw new Error("Session expired — redirecting to login");
  }

  // ── Layer 2: fetch interceptor for mid-session expiry ────────────

  const originalFetch = window.fetch;

  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);

    if (response.status === 401) {
      // Clone so callers that try to read the body don't get an
      // already-consumed stream, but redirect immediately.
      redirectToLogin();
      // Return a cloned response so any in-progress .then() chains
      // don't throw "body already read" errors before the redirect lands.
      return response.clone();
    }

    return response;
  };

  // ── Expose helpers for pages that need them ───────────────────────

  window.authGuard = {
    getToken,
    // Convenience: build the Authorization header object every page needs.
    authHeaders() {
      return {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getToken()}`,
      };
    },
    logout() {
      localStorage.clear();
      window.location.href = LOGIN_PAGE;
    },
  };
})();
