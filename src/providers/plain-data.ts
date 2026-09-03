import { types } from "node:util";

const intrinsicObjectPrototype = Object.prototype;
const intrinsicArrayPrototype = Array.prototype;
const intrinsicFunctionPrototype = Function.prototype;
const objectPrototypeKeys = Reflect.ownKeys(intrinsicObjectPrototype);
const arrayPrototypeKeys = Reflect.ownKeys(intrinsicArrayPrototype);
const functionPrototypeKeys = Reflect.ownKeys(intrinsicFunctionPrototype);
const objectPrototypeDescriptors = Object.getOwnPropertyDescriptors(intrinsicObjectPrototype) as unknown as Record<PropertyKey, PropertyDescriptor>;
const arrayPrototypeDescriptors = Object.getOwnPropertyDescriptors(intrinsicArrayPrototype) as unknown as Record<PropertyKey, PropertyDescriptor>;
const functionPrototypeDescriptors = Object.getOwnPropertyDescriptors(intrinsicFunctionPrototype) as unknown as Record<PropertyKey, PropertyDescriptor>;
const intrinsicFunctionToString = Function.prototype.toString;
const reflectApply = Reflect.apply;
const reflectOwnKeys = Reflect.ownKeys;
const getOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
const getPrototypeOf = Object.getPrototypeOf;
const arrayIsArray = Array.isArray;
const isProxy = types.isProxy;

function sameKeys(left: readonly PropertyKey[], right: readonly PropertyKey[]): boolean {
  if (left.length !== right.length) return false;
  for (const leftKey of left) {
    let found = false;
    for (const rightKey of right) {
      if (leftKey === rightKey) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

function safeFunction(value: unknown): value is Function {
  return typeof value === "function" && !isProxy(value);
}

function sameDescriptorFlags(candidate: PropertyDescriptor | undefined, intrinsic: PropertyDescriptor): boolean {
  return candidate !== undefined &&
    candidate.enumerable === intrinsic.enumerable &&
    candidate.configurable === intrinsic.configurable &&
    ("value" in candidate) === ("value" in intrinsic) &&
    (!("value" in intrinsic) || ("value" in candidate && candidate.writable === intrinsic.writable));
}

function samePrimitiveDataDescriptor(
  candidate: PropertyDescriptor | undefined,
  intrinsic: PropertyDescriptor | undefined,
): boolean {
  return candidate !== undefined && intrinsic !== undefined &&
    "value" in candidate && "value" in intrinsic &&
    sameDescriptorFlags(candidate, intrinsic) && candidate.value === intrinsic.value;
}

function nativeSource(value: Function): string {
  return reflectApply(intrinsicFunctionToString, value, []) as string;
}

function hasExpectedNativeFunctionIdentity(
  candidate: unknown,
  intrinsic: unknown,
  functionPrototype: object,
): candidate is Function {
  if (!safeFunction(candidate) || !safeFunction(intrinsic)) return false;
  if (getPrototypeOf(candidate) !== functionPrototype) return false;
  if (nativeSource(candidate) !== nativeSource(intrinsic)) return false;

  const candidateDescriptors = getOwnPropertyDescriptors(candidate);
  const intrinsicDescriptors = getOwnPropertyDescriptors(intrinsic);
  return samePrimitiveDataDescriptor(candidateDescriptors.name, intrinsicDescriptors.name) &&
    samePrimitiveDataDescriptor(candidateDescriptors.length, intrinsicDescriptors.length);
}

function hasIntrinsicFunctionPrototypeShape(candidate: unknown, objectPrototype: object): candidate is Function {
  if (!safeFunction(candidate) || getPrototypeOf(candidate) !== objectPrototype) return false;
  if (nativeSource(candidate) !== nativeSource(intrinsicFunctionPrototype)) return false;

  const keys = reflectOwnKeys(candidate);
  if (!sameKeys(keys, functionPrototypeKeys)) return false;
  const descriptors = getOwnPropertyDescriptors(candidate) as unknown as Record<PropertyKey, PropertyDescriptor>;
  for (const key of functionPrototypeKeys) {
    const descriptor = descriptors[key];
    const intrinsic = functionPrototypeDescriptors[key];
    if (intrinsic === undefined || !sameDescriptorFlags(descriptor, intrinsic) || descriptor === undefined) return false;
    if ("value" in intrinsic) {
      if (!("value" in descriptor)) return false;
      if (typeof intrinsic.value === "function") {
        if (!hasExpectedNativeFunctionIdentity(descriptor.value, intrinsic.value, candidate)) return false;
      } else if (descriptor.value !== intrinsic.value) {
        return false;
      }
    } else {
      if (intrinsic.get === undefined) {
        if (descriptor.get !== undefined) return false;
      } else if (!hasExpectedNativeFunctionIdentity(descriptor.get, intrinsic.get, candidate)) {
        return false;
      }
      if (intrinsic.set === undefined) {
        if (descriptor.set !== undefined) return false;
      } else if (!hasExpectedNativeFunctionIdentity(descriptor.set, intrinsic.set, candidate)) {
        return false;
      }
    }
  }

  const constructor = descriptors["constructor"];
  const prototype = constructor !== undefined && "value" in constructor
    ? getOwnPropertyDescriptors(constructor.value).prototype
    : undefined;
  return prototype !== undefined && "value" in prototype && prototype.value === candidate;
}

function sameIntrinsicDescriptor(
  candidate: PropertyDescriptor | undefined,
  intrinsic: PropertyDescriptor,
  functionPrototype: object,
): boolean {
  if (!sameDescriptorFlags(candidate, intrinsic) || candidate === undefined) return false;
  if ("value" in intrinsic) {
    if (!("value" in candidate)) return false;
    if (typeof intrinsic.value === "function") {
      return hasExpectedNativeFunctionIdentity(candidate.value, intrinsic.value, functionPrototype);
    }
    if (typeof intrinsic.value === "object" && intrinsic.value !== null) {
      return typeof candidate.value === "object" && candidate.value !== null && !isProxy(candidate.value);
    }
    return candidate.value === intrinsic.value;
  }
  return (
    (intrinsic.get === undefined
      ? candidate.get === undefined
      : hasExpectedNativeFunctionIdentity(candidate.get, intrinsic.get, functionPrototype)) &&
    (intrinsic.set === undefined
      ? candidate.set === undefined
      : hasExpectedNativeFunctionIdentity(candidate.set, intrinsic.set, functionPrototype))
  );
}

function hasIntrinsicPrototypeShape(
  candidate: object,
  intrinsicKeys: readonly PropertyKey[],
  intrinsicDescriptors: Record<PropertyKey, PropertyDescriptor>,
  intrinsicConstructor: Function,
  objectPrototype: object,
): boolean {
  if (isProxy(candidate)) return false;
  const keys = reflectOwnKeys(candidate);
  if (!sameKeys(keys, intrinsicKeys)) return false;
  const descriptors = getOwnPropertyDescriptors(candidate) as unknown as Record<PropertyKey, PropertyDescriptor>;
  const constructorDescriptor = descriptors["constructor"];
  if (
    constructorDescriptor === undefined || !("value" in constructorDescriptor) ||
    !safeFunction(constructorDescriptor.value)
  ) return false;
  const functionPrototype = getPrototypeOf(constructorDescriptor.value) as unknown;
  if (!hasIntrinsicFunctionPrototypeShape(functionPrototype, objectPrototype)) return false;

  for (const key of intrinsicKeys) {
    const intrinsic = intrinsicDescriptors[key];
    if (intrinsic === undefined || !sameIntrinsicDescriptor(descriptors[key], intrinsic, functionPrototype)) return false;
  }
  if (!hasExpectedNativeFunctionIdentity(constructorDescriptor.value, intrinsicConstructor, functionPrototype)) return false;
  const constructorPrototype = getOwnPropertyDescriptors(constructorDescriptor.value).prototype;
  const intrinsicConstructorPrototype = getOwnPropertyDescriptors(intrinsicConstructor).prototype;
  return constructorPrototype !== undefined && intrinsicConstructorPrototype !== undefined &&
    "value" in constructorPrototype && "value" in intrinsicConstructorPrototype &&
    sameDescriptorFlags(constructorPrototype, intrinsicConstructorPrototype) &&
    constructorPrototype.value === candidate;
}

function isOrdinaryObjectPrototype(value: unknown): value is object {
  if (typeof value !== "object" || value === null || isProxy(value)) return false;
  if (getPrototypeOf(value) !== null) return false;
  return value === intrinsicObjectPrototype || hasIntrinsicPrototypeShape(
    value,
    objectPrototypeKeys,
    objectPrototypeDescriptors,
    Object,
    value,
  );
}

function isOrdinaryArrayPrototype(value: unknown): value is object {
  if (typeof value !== "object" || value === null || isProxy(value)) return false;
  const parent = getPrototypeOf(value) as unknown;
  if (!isOrdinaryObjectPrototype(parent)) return false;
  return value === intrinsicArrayPrototype || hasIntrinsicPrototypeShape(
    value,
    arrayPrototypeKeys,
    arrayPrototypeDescriptors,
    Array,
    parent,
  );
}

export function isOrdinaryDataObject(value: unknown): value is object {
  if (typeof value !== "object" || value === null || isProxy(value) || arrayIsArray(value)) return false;
  try {
    return isOrdinaryObjectPrototype(getPrototypeOf(value) as unknown);
  } catch {
    return false;
  }
}

export function isOrdinaryDataArray(value: unknown): value is readonly unknown[] {
  if (typeof value !== "object" || value === null || isProxy(value) || !arrayIsArray(value)) return false;
  try {
    return isOrdinaryArrayPrototype(getPrototypeOf(value) as unknown);
  } catch {
    return false;
  }
}
