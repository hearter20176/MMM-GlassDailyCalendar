// Records every call so tests can assert on the options node_helper passed
// (e.g. that an AbortSignal timeout was set), then always rejects so the
// error-handling path under test runs without needing real network access.
let lastCalls = [];

function fakeFetch(url, opts) {
  lastCalls.push({ url, opts });
  return Promise.reject(new Error("stubbed network failure"));
}

fakeFetch.__getCalls = () => lastCalls;
fakeFetch.__reset = () => {
  lastCalls = [];
};

module.exports = { default: fakeFetch };
