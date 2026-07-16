import crypto from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTVWXYZabcdefghjkmnpqrstvwxyz0123456789';

export function id(prefix, len = 22) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return `${prefix}_${out}`;
}

export const newAgentId = () => id('agent');
export const newEnvironmentId = () => id('env');
export const newSessionId = () => id('sess');
export const newEventId = () => id('evt');
export const newDeploymentId = () => id('depl');
export const newDeploymentRunId = () => id('drun');
export const newKeyId = () => id('pk');
