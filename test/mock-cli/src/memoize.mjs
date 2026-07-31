// test/mock-cli/src/memoize.mjs — 手写 lodash.memoize 等价物。
// 真 CLI 用 lodash-es/memoize.js（utils/envUtils.ts:1、utils/betas.ts:2）。
// mock 不引入 lodash，这里 20 行等价实现。
//
// 接口与 lodash.memoize 一致：
//   memoize(fn, resolver=(...a)=>a[0]) → memoized
//   memoized.cache = Map  （真 CLI 调 .cache?.clear?.()）
//   memoized.cache.clear = () => map.clear()
//
// resolver 决定缓存 key：configHome 用动态 key () => process.env.CLAUDE_CONFIG_DIR，
// betas 用默认（model 字符串）。
export function memoize(fn, resolver = (...args) => args[0]) {
    function memoized(...args) {
        const key = resolver(...args);
        if (memoized.cache.has(key)) {
            return memoized.cache.get(key);
        }
        const result = fn.apply(this, args);
        memoized.cache.set(key, result);
        return result;
    }
    memoized.cache = new Map();
    // 真 CLI 调 .cache?.clear?.()——直接用 Map 原生 clear 即可（lodash 也是 Map 实例 + 原生 clear）。
    return memoized;
}
