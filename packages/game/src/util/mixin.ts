/**
 * Mixes system classes into one target class: every method and accessor of each source prototype is defined on the
 * target prototype with its own descriptor (non-enumerable, like class methods). The sources are never instantiated;
 * their methods declare `this` as the target. A name defined twice is a load-time error, so no system shadows another.
 */
export function mixin(target: { prototype: object }, sources: readonly { prototype: object }[]): void {
  for (const source of sources) {
    for (const name of Object.getOwnPropertyNames(source.prototype)) {
      if (name === 'constructor') continue;
      if (Object.hasOwn(target.prototype, name)) throw new Error(`mixin: ${name} is defined twice`);
      Object.defineProperty(target.prototype, name, Object.getOwnPropertyDescriptor(source.prototype, name) as PropertyDescriptor);
    }
  }
}
