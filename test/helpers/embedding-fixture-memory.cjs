// Only fake-backend subprocess tests preload this. Their synthetic vectors do
// not allocate a model, so host memory pressure must not suppress the operation
// under test. Production macOS smoke uses the real memory guard and runtime.
require('node:os').freemem = () => 8 * 1024 ** 3;
