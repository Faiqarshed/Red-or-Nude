// `server-only` ships two entry points: under the react-server condition an
// empty module, otherwise a single `throw`. Vitest has no RSC pipeline, so the
// condition would also drag in react.shared-subset — which throws on 18.3.1.
// Stubbing the package directly gets the empty module without the condition.
export {};
