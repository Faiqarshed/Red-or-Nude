// `server-only` is a build-time guard: importing it from a client bundle is
// meant to fail. Under the test runner there is no client bundle and no RSC
// graph, so it is aliased to this. Same trick as the check scripts'
// `--conditions=react-server`, done as an alias because an alias cannot be
// resolved differently by a transitive dependency.
export {};
