import { route } from '../lib/vercel.js';

export default function handler(req, res) {
  return route(req, res, '/api/health');
}
