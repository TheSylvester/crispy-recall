/**
 * BindingLoadError remediation — defect 3 (Node-23 hole / binding-load guidance).
 *
 * A failed native-binding load must tell the user the two real causes and how to
 * fix each: (a) recall running under a different Node than npm installed it with,
 * and (b) no prebuilt binary for their Node version (Node 23) + missing Xcode CLT.
 * Also guards isBindingLoadError, the classifier the Stop-hook soft-fail and the
 * Fix-4 staging probe both depend on.
 */
import { describe, expect, it } from 'vitest';
import { BindingLoadError, isBindingLoadError } from '../../src/db.js';

describe('BindingLoadError remediation', () => {
  const err = new BindingLoadError(
    '/home/u/.recall/recall.db',
    new Error('was compiled against a different Node.js version using NODE_MODULE_VERSION 127. This version requires 137.'),
  );

  it('includes the db path and the underlying cause', () => {
    expect(err.message).toContain('/home/u/.recall/recall.db');
    expect(err.message).toContain('NODE_MODULE_VERSION 127');
    expect(err.name).toBe('BindingLoadError');
  });

  it('names the two-node mismatch remedy (reinstall under the PATH node)', () => {
    expect(err.message).toContain('npm install -g crispy-recall');
    expect(err.message).toMatch(/Homebrew|nvm/);
  });

  it('names the Node-23 prebuild hole and the Xcode CLT remedy', () => {
    expect(err.message).toContain('Node 23');
    expect(err.message).toContain('xcode-select --install');
  });

  it('still points at recall doctor', () => {
    expect(err.message).toContain('recall doctor');
  });
});

describe('isBindingLoadError classifier (unchanged contract)', () => {
  it('matches an ERR_DLOPEN_FAILED code', () => {
    expect(isBindingLoadError({ code: 'ERR_DLOPEN_FAILED', message: 'dlopen failed' })).toBe(true);
  });
  it('matches a NODE_MODULE_VERSION mismatch message', () => {
    expect(isBindingLoadError(new Error('compiled against a different Node.js version using NODE_MODULE_VERSION 127'))).toBe(true);
  });
  it('does not match an unrelated error', () => {
    expect(isBindingLoadError(new Error('disk is full'))).toBe(false);
  });
});
