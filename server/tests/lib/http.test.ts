import { describe, expect, it, vi } from 'vitest';
import { asyncHandler, createHttpError, getRouteParam, HttpError } from '../../src/lib/http';

describe('http helpers', () => {
  it('creates typed HTTP errors', () => {
    const error = createHttpError(409, 'Nope');

    expect(error).toBeInstanceOf(HttpError);
    expect(error.statusCode).toBe(409);
    expect(error.message).toBe('Nope');
  });

  it('returns route params as strings', () => {
    const req = { params: { id: 'repo-1', splat: ['first', 'second'] } } as any;

    expect(getRouteParam(req, 'id')).toBe('repo-1');
    expect(getRouteParam(req, 'splat')).toBe('first');
    expect(getRouteParam(req, 'missing')).toBe('');
  });

  it('forwards async errors to next', async () => {
    const error = new Error('boom');
    const next = vi.fn();
    const handler = asyncHandler(async () => {
      throw error;
    });

    handler({} as any, {} as any, next);
    await Promise.resolve();

    expect(next).toHaveBeenCalledWith(error);
  });
});
