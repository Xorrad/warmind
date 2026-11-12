/**
 * @file Fetch wrappers for auth, campaign and tasks endpoints.
 */

/**
 * @returns {Promise<{version: string, commit: string|null, env: string, builtAt: string}>}
 */
export async function getBuild() {
    const res = await fetch('/api/build');
    if (!res.ok) throw new Error(`GET /api/build failed: ${res.status}`);
    return res.json();
}
