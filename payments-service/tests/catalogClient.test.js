describe('catalogClient', () => {
  const originalFetch = global.fetch;
  const originalTimeout = process.env.CATALOG_REQUEST_TIMEOUT_MS;

  beforeEach(() => {
    jest.resetModules();
    process.env.CATALOG_REQUEST_TIMEOUT_MS = '20';
  });

  afterEach(() => {
    global.fetch = originalFetch;

    if (originalTimeout === undefined) {
      delete process.env.CATALOG_REQUEST_TIMEOUT_MS;
    } else {
      process.env.CATALOG_REQUEST_TIMEOUT_MS = originalTimeout;
    }
  });

  it('returns Catalog response data on success', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: jest.fn().mockResolvedValue(
        JSON.stringify({
          message: 'Stock reserved successfully',
        })
      ),
    });

    const { reserveStock } = require('../src/catalogClient');

    await expect(
      reserveStock(
        501,
        [{ productId: 1, quantity: 1 }],
        'catalog-client-test-501'
      )
    ).resolves.toEqual({
      message: 'Stock reserved successfully',
    });

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/products/reserve-stock'),
      expect.objectContaining({
        method: 'POST',
        signal: expect.any(AbortSignal),
      })
    );
  });

  it('aborts a hanging Catalog request with ETIMEDOUT', async () => {
    global.fetch = jest.fn(
      (_, options) =>
        new Promise((_, reject) => {
          options.signal.addEventListener('abort', () => {
            const error = new Error('The operation was aborted');
            error.name = 'AbortError';
            reject(error);
          });
        })
    );

    const { reserveStock } = require('../src/catalogClient');

    await expect(
      reserveStock(
        502,
        [{ productId: 1, quantity: 1 }],
        'catalog-client-timeout-502'
      )
    ).rejects.toMatchObject({
      code: 'ETIMEDOUT',
      message: 'Catalog service request timed out after 20ms',
    });
  });
});
