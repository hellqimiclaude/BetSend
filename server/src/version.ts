/**
 * The running version, in one place.
 *
 * A literal rather than a read of package.json: the packaged server ships
 * `server/dist` and nothing else from that folder, so there is no
 * package.json beside the code to read at runtime. Bumped with the
 * installers as part of cutting a release.
 */
export const APP_VERSION = '1.5.3';
