import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";

import { isOrdinaryDataArray, isOrdinaryDataObject } from "../../src/providers/plain-data.js";
import { parseProviderModels } from "../../src/providers/provider-definitions.js";
import { parseConnectionProfile } from "../../src/providers/profile-contracts.js";

type ExecutionTracker = { executions: number };
type CounterfeitData = {
  object: unknown;
  array: unknown;
  profile: unknown;
  models: unknown;
  prototypes: {
    object: object;
    array: object;
    constructor: Function;
    functionPrototype: object;
    method: Function;
    accessor: Function;
  };
};

const counterfeitFactory = `(() => {
  function replacement(name, length) {
    const fn = function () { tracker.executions += 1; throw new Error("counterfeit executed"); };
    Object.defineProperties(fn, {
      name: { value: name, configurable: true },
      length: { value: length, configurable: true },
    });
    return fn;
  }

  function cloneDescriptors(intrinsic, substitutions) {
    const descriptors = Object.getOwnPropertyDescriptors(intrinsic);
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key];
      if (key === "constructor") continue;
      if ("value" in descriptor && typeof descriptor.value === "function") {
        descriptor.value = substitutions === "real" ? descriptor.value : replacement(descriptor.value.name, descriptor.value.length);
      } else {
        if (typeof descriptor.get === "function") {
          descriptor.get = substitutions === "real" ? descriptor.get : replacement(descriptor.get.name, descriptor.get.length);
        }
        if (typeof descriptor.set === "function") {
          descriptor.set = substitutions === "real" ? descriptor.set : replacement(descriptor.set.name, descriptor.set.length);
        }
      }
    }
    return descriptors;
  }

  function clonePrototype(intrinsic, parent, constructorName, substitutions) {
    const prototype = Object.create(parent);
    const descriptors = cloneDescriptors(intrinsic, substitutions);
    const constructor = replacement(constructorName, constructorName === "Array" ? 1 : 1);
    Object.defineProperty(constructor, "prototype", { value: prototype, writable: false });
    descriptors.constructor.value = constructor;
    Object.defineProperties(prototype, descriptors);
    return { prototype, constructor };
  }

  const fakeObject = clonePrototype(Object.prototype, null, "Object", mode);
  const fakeArray = clonePrototype(Array.prototype, fakeObject.prototype, "Array", mode);
  const object = Object.setPrototypeOf({ safe: true }, fakeObject.prototype);
  const array = Object.setPrototypeOf([{ id: "owner/model" }], fakeArray.prototype);
  const profile = Object.setPrototypeOf({
    id: "connection.counterfeit",
    revision: 1,
    target: { class: "approved-provider", definitionId: "openai" },
  }, fakeObject.prototype);
  const models = Object.setPrototypeOf([{ id: "owner/model" }], fakeArray.prototype);
  const objectDescriptors = Object.getOwnPropertyDescriptors(fakeObject.prototype);
  return {
    object,
    array,
    profile,
    models,
    prototypes: {
      object: fakeObject.prototype,
      array: fakeArray.prototype,
      constructor: fakeObject.constructor,
      functionPrototype: Object.getPrototypeOf(fakeObject.constructor),
      method: objectDescriptors.toString.value,
      accessor: objectDescriptors.__proto__.get,
    },
  };
})()`;

function createCounterfeits(tracker: ExecutionTracker, mode: "counterfeit" | "real" = "counterfeit"): CounterfeitData {
  return vm.runInNewContext(counterfeitFactory, { tracker, mode }) as CounterfeitData;
}

function traplessProxy<T extends object>(target: T, tracker: ExecutionTracker): T {
  const traps: ProxyHandler<T> = {};
  for (const name of ["get", "getOwnPropertyDescriptor", "getPrototypeOf", "has", "ownKeys"] as const) {
    traps[name] = (() => {
      tracker.executions += 1;
      throw new Error(`proxy ${name} trap executed`);
    }) as never;
  }
  return new Proxy(target, traps);
}

test("counterfeit cross-realm Object and Array prototype clones are rejected without executing hooks", () => {
  const tracker = { executions: 0 };
  const counterfeit = createCounterfeits(tracker);

  assert.equal(isOrdinaryDataObject(counterfeit.object), false);
  assert.equal(isOrdinaryDataArray(counterfeit.array), false);
  assert.throws(() => parseConnectionProfile(counterfeit.profile), TypeError);
  assert.throws(() => parseProviderModels("together", counterfeit.models), /invalid/i);
  assert.equal(tracker.executions, 0);
});

test("fake prototypes made from genuine intrinsic descriptors are not accepted as realm prototypes", () => {
  const tracker = { executions: 0 };
  const counterfeit = createCounterfeits(tracker, "real");

  assert.equal(isOrdinaryDataObject(counterfeit.object), false);
  assert.equal(isOrdinaryDataArray(counterfeit.array), false);
  assert.equal(tracker.executions, 0);
});

test("plain data accepts frozen and unfrozen values from multiple independent vm realms", () => {
  for (const frozen of [false, true]) {
    for (let context = 0; context < 3; context += 1) {
      const value = vm.runInNewContext(`(() => {
        const value = { context: ${context}, nested: [{ ok: true }, [1, 2, 3]] };
        if (${String(frozen)}) {
          Object.freeze(value.nested[0]);
          Object.freeze(value.nested[1]);
          Object.freeze(value.nested);
          Object.freeze(value);
        }
        return value;
      })()` ) as { nested: unknown[] };
      assert.equal(isOrdinaryDataObject(value), true);
      assert.equal(isOrdinaryDataArray(value.nested), true);
      assert.equal(isOrdinaryDataObject(value.nested[0]), true);
      assert.equal(isOrdinaryDataArray(value.nested[1]), true);
    }
  }

  assert.equal(isOrdinaryDataObject(Object.create(null)), false);
});

test("prototype authentication rejects proxies at every reflected level without executing traps", () => {
  const tracker = { executions: 0 };
  const cases: unknown[] = [];

  cases.push(traplessProxy({}, tracker));
  assert.equal(isOrdinaryDataArray(traplessProxy([], tracker)), false);

  const proxiedObjectPrototype = traplessProxy({}, tracker);
  cases.push(Object.create(proxiedObjectPrototype));
  const proxiedArrayPrototype = traplessProxy(Array.prototype, tracker);
  assert.equal(isOrdinaryDataArray(Object.setPrototypeOf([], proxiedArrayPrototype)), false);

  for (const level of ["constructor", "functionPrototype", "method", "accessor"] as const) {
    const realm = vm.runInNewContext(`({
      value: {},
      objectPrototype: Object.prototype,
      constructor: Object,
      functionPrototype: Function.prototype,
      method: Object.prototype.toString,
      accessor: Object.getOwnPropertyDescriptor(Object.prototype, "__proto__").get,
    })`) as {
      value: object;
      objectPrototype: object;
      constructor: Function;
      functionPrototype: object;
      method: Function;
      accessor: Function;
    };
    if (level === "constructor") {
      Object.defineProperty(realm.objectPrototype, "constructor", {
        ...Object.getOwnPropertyDescriptor(realm.objectPrototype, "constructor"),
        value: traplessProxy(realm.constructor, tracker),
      });
    } else if (level === "method") {
      Object.defineProperty(realm.objectPrototype, "toString", {
        ...Object.getOwnPropertyDescriptor(realm.objectPrototype, "toString"),
        value: traplessProxy(realm.method, tracker),
      });
    } else if (level === "accessor") {
      Object.defineProperty(realm.objectPrototype, "__proto__", {
        ...Object.getOwnPropertyDescriptor(realm.objectPrototype, "__proto__"),
        get: traplessProxy(realm.accessor, tracker) as () => unknown,
      });
    } else {
      Object.setPrototypeOf(realm.constructor, traplessProxy(realm.functionPrototype, tracker));
    }
    cases.push(realm.value);
  }

  for (const value of cases) assert.equal(isOrdinaryDataObject(value), false);
  assert.equal(tracker.executions, 0);
});

test("mixed-realm intrinsic descriptor sets are rejected without invoking any function", () => {
  const tracker = { executions: 0 };
  const first = vm.runInNewContext("({ value: {}, prototype: Object.prototype })") as {
    value: object;
    prototype: object;
  };
  const secondMethod = vm.runInNewContext("Object.prototype.toString") as Function;
  Object.defineProperty(first.prototype, "toString", {
    ...Object.getOwnPropertyDescriptor(first.prototype, "toString"),
    value: secondMethod,
  });

  assert.equal(isOrdinaryDataObject(first.value), false);
  assert.equal(tracker.executions, 0);
});
