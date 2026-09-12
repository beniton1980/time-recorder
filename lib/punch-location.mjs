// A single, short-lived position for this screen. Never persist coordinates or watch movement.
export const PUNCH_LOCATION_OPTIONS = Object.freeze({
  enableHighAccuracy: true,
  timeout: 10000,
  maximumAge: 30000,
});

export function createPunchLocationReader({ geolocation, permissions, now = Date.now }) {
  let pending = null;
  let sample = null;
  let expiry = null;
  let generation = 0;

  function fresh(value) {
    const age = now() - (value?.timestamp ?? NaN);
    return Number.isFinite(age) && age >= 0 && age <= PUNCH_LOCATION_OPTIONS.maximumAge;
  }

  function forgetSample() {
    sample = null;
    if (expiry !== null) clearTimeout(expiry);
    expiry = null;
  }

  function request() {
    const requestedGeneration = generation;
    const promise = new Promise((resolve) => {
      if (!geolocation) return resolve(null);
      try {
        geolocation.getCurrentPosition(
          (position) => resolve({
            timestamp: position.timestamp,
            location: {
              latitude: position.coords.latitude,
              longitude: position.coords.longitude,
              accuracy: position.coords.accuracy,
            },
          }),
          () => resolve(null),
          PUNCH_LOCATION_OPTIONS,
        );
      } catch {
        resolve(null);
      }
    }).then((value) => {
      if (requestedGeneration === generation) {
        pending = null;
        forgetSample();
        if (fresh(value)) {
          sample = value;
          expiry = setTimeout(forgetSample, Math.max(0, PUNCH_LOCATION_OPTIONS.maximumAge - (now() - value.timestamp)));
        }
      }
      return value;
    });
    pending = promise;
    return promise;
  }

  return {
    async prepare() {
      const requestedGeneration = generation;
      try {
        // Never trigger a first-time permission prompt merely by opening the screen.
        const permission = await permissions?.query({ name: "geolocation" });
        if (permission?.state !== "granted" || requestedGeneration !== generation) return;
        if (!pending && !fresh(sample)) await request();
      } catch {
        // Unsupported Permissions API: keep the existing on-tap request flow.
      }
    },
    async read() {
      const value = fresh(sample) ? sample : await (pending ?? request());
      forgetSample();
      return fresh(value) ? value.location : null;
    },
    clear() {
      generation += 1;
      pending = null;
      forgetSample();
    },
  };
}
