import Joi from 'joi';
import * as db from '../db/manager.js';

export function setup(mstream) {
  // GET /api/v1/user/settings  — load prefs + queue for the authenticated user
  mstream.get('/api/v1/user/settings', (req, res) => {
    const username = req.user?.username || 'mstream-user';
    res.json(db.getUserSettings(username));
  });

  // POST /api/v1/user/settings  — save/merge prefs and/or queue
  mstream.post('/api/v1/user/settings', async (req, res) => {
    const schema = Joi.object({
      prefs: Joi.object().unknown(true).optional(),
      queue: Joi.any().optional(),
    });
    await schema.validateAsync(req.body);
    const username = req.user?.username || 'mstream-user';
    db.saveUserSettings(username, req.body);
    res.json({ ok: true });
  });
}
