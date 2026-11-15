import { describe, it, expect, afterEach } from 'vitest';
import { start } from './helpers/server.js';

describe('production readiness', () => {
    let srv;
    afterEach(() => srv?.close());

    it('answers health checks, including the database', async () => {
        srv = await start();
        const res = await srv.client().get('/api/health');
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ ok: true, version: expect.any(String) });
        srv.db.close();
        expect((await srv.client().get('/api/health')).status).toBe(503);
    });

    it('sends a Content-Security-Policy allowing only this origin and the import map', async () => {
        srv = await start();
        const res = await fetch(new URL('/', `http://127.0.0.1:${srv.port}`));
        const csp = res.headers.get('content-security-policy');
        expect(csp).toMatch(/default-src 'self'/);
        expect(csp).toMatch(/script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/);
        expect(csp).toMatch(/frame-ancestors 'none'/);
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        expect(res.headers.get('strict-transport-security')).toBeNull();
    });

    it('serves pages without their extension and redirects the old URLs', async () => {
        srv = await start();
        const base = `http://127.0.0.1:${srv.port}`;
        const get = (p) => fetch(base + p, { redirect: 'manual' });
        const page = await get('/login/?next=%2F');
        expect(page.status).toBe(200);
        expect(await page.text()).toContain('<title>WarMind: Log in</title>');
        for (const [from, to] of [
            ['/login.html?next=%2F%3Fx%3D1', '/login/?next=%2F%3Fx%3D1'],
            ['/login', '/login/'],
            ['/login?mode=register', '/login/?mode=register'],
            ['/index.html', '/'],
            ['/index.html?a=b', '/?a=b'],
        ]) {
            const res = await get(from);
            expect(res.status, from).toBe(301);
            expect(res.headers.get('location'), from).toBe(to);
        }
        expect((await get('/')).status).toBe(200);
        expect((await get('/css/base.css')).status).toBe(200);
        expect((await get('/nope/')).status).toBe(404);
    });

    it('marks every API answer as not cacheable', async () => {
        srv = await start();
        const c = srv.client();
        for (const path of ['/api/build', '/api/health', '/api/auth/me', '/api/save', '/api/nope']) {
            expect((await c.get(path)).headers.get('cache-control'), path).toBe('no-store');
        }
    });

    it('requires HTTPS (HSTS) when cookies are secure', async () => {
        srv = await start({ secureCookies: true });
        const res = await srv.client().get('/api/health');
        expect(res.headers.get('strict-transport-security')).toMatch(/max-age=\d+/);
    });

    it('tells the client whether test sessions are allowed', async () => {
        srv = await start({ testSessions: false });
        expect((await srv.client().get('/api/build')).body.testSessions).toBe(false);
        await srv.close();
        srv = await start();
        expect((await srv.client().get('/api/build')).body.testSessions).toBe(true);
    });
});
