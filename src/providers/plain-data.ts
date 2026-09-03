import { types } from "node:util";

const objectPrototypeKeys = Reflect.ownKeys(Object.prototype);
const arrayPrototypeKeys = Reflect.ownKeys(Array.prototype);
const objectPrototypeDescriptors = Object.getOwnPropertyDescriptors(Object.prototype) as unknown as Record<PropertyKey, PropertyDescriptor>;
const arrayPrototypeDescriptors = Object.getOwnPropertyDescriptors(Array.prototype) as unknown as Record<PropertyKey, PropertyDescriptor>;

function sameKeys(left: readonly PropertyKey[], right: readonly PropertyKey[]): boolean {
  return left.length === right.length && left.every((key) => right.includes(key));
}

function safeFunction(value: unknown): value is Function {
  return typeof value === "function" && !types.isProxy(value);
}

function sameDescriptorShape(candidate: PropertyDescriptor | undefined, intrinsic: PropertyDescriptor): boolean {
  if (
    candidate === undefined ||
    candidate.enumerable !== intrinsic.enumerable ||
    candidate.configurable !== intrinsic.configurable ||
    ("value" in candidate) !== ("value" in intrinsic)
  ) return false;
  if ("value" in intrinsic) {
    if (!("value" in candidate) || candidate.writable !== intrinsic.writable) return false;
    if (typeof intrinsic.value === "function") return safeFunction(candidate.value);
    if (typeof intrinsic.value === "object" && intrinsic.value !== null) {
      return typeof candidate.value === "object" && candidate.value !== null && !types.isProxy(candidate.value);
    }
    return candidate.value === intrinsic.value;
  }
  return (
    (intrinsic.get === undefined ? candidate.get === undefined : safeFunction(candidate.get)) &&
    (intrinsic.set === undefined ? candidate.set === undefined : safeFunction(candidate.set))
  );
}

function hasIntrinsicPrototypeShape(
  candidate: object,
  intrinsicKeys: readonly PropertyKey[],
  intrinsicDescriptors: Record<PropertyKey, PropertyDescriptor>,
  expectedName: "Object" | "Array",
): boolean {
  if (types.isProxy(candidate)) return false;
  const keys = Reflect.ownKeys(candidate);
  if (!sameKeys(keys, intrinsicKeys)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(candidate) as Record<PropertyKey, PropertyDescriptor>;
  for (const key of intrinsicKeys) {
    const intrinsic = intrinsicDescriptors[key];
    if (intrinsic === undefined || !sameDescriptorShape(descriptors[key], intrinsic)) return false;
  }
  const constructor = descriptors.constructor;
  if (constructor === undefined || !("value" in constructor) || !safeFunction(constructor.value)) return false;
  const constructorDescriptors = Object.getOwnPropertyDescriptors(constructor.value) as Record<PropertyKey, PropertyDescriptor>;
  const name = constructorDescriptors.name;
  const prototype = constructorDescriptors.prototype;
  return name !== undefined && "value" in name && name.value === expectedName &&
    prototype !== undefined && "value" in prototype && prototype.value === candidate;
}

function isOrdinaryObjectPrototype(value: unknown): value is object {
  if (typeof value !== "object" || value === null || types.isProxy(value)) return false;
  if (Object.getPrototypeOf(value) !== null) return false;
  return value === Object.prototype || hasIntrinsicPrototypeShape(
    value,
    objectPrototypeKeys,
    objectPrototypeDescriptors,
    "Object",
  );
}

function isOrdinaryArrayPrototype(value: unknown): value is object {
  if (typeof value !== "object" || value === null || types.isProxy(value)) return false;
  const parent = Object.getPrototypeOf(value) as unknown;
  if (!isOrdinaryObjectPrototype(parent)) return false;
  return value === Array.prototype || hasIntrinsicPrototypeShape(
    value,
    arrayPrototypeKeys,
    arrayPrototypeDescriptors,
    "Array",
  );
}

export function isOrdinaryDataObject(value: unknown): value is object {
  if (typeof value !== "object" || value === null || types.isProxy(value) || Array.isArray(value)) return false;
  return isOrdinaryObjectPrototype(Object.getPrototypeOf(value) as unknown);
}

export function isOrdinaryDataArray(value: unknown): value is readonly unknown[] {
  if (typeof value !== "object" || value === null || types.isProxy(value) || !Array.isArray(value)) return false;
  return isOrdinaryArrayPrototype(Object.getPrototypeOf(value) as unknown);
}
