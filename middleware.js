/**
 * Optional HTTP Basic auth for the public deployment.
 *
 * Set APP_PASSWORD in the Vercel project to require a password. Any username
 * works; the password must match APP_PASSWORD. Leave it unset for a public site.
 */
export default function middleware(request) {
  const password = process.env.APP_PASSWORD;
  if (!password) return;

  const header = request.headers.get('authorization') || '';
  if (header.startsWith('Basic ')) {
    let decoded = '';
    try {
      decoded = atob(header.slice(6));
    } catch {
      decoded = '';
    }
    const separator = decoded.indexOf(':');
    const supplied = separator >= 0 ? decoded.slice(separator + 1) : decoded;
    if (supplied && supplied === password) return;
  }

  return new Response('Authentication required', {
    status: 401,
    headers: {
      'www-authenticate': 'Basic realm="my_grader", charset="UTF-8"',
      'cache-control': 'no-store',
    },
  });
}

export const config = { matcher: '/:path*' };
