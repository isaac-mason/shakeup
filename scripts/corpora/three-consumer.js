// LIBRARY-CONSUMER corpus — the workload every other corpus in this repo is missing.
//
// crashcat and three.core.js are both "everything live": an application bundling its own source, or a
// whole library bundled as itself. Neither says anything about the case that dominates real builds —
// an app importing a LARGE dependency and using a sliver of it. A downstream report on `kit` put that
// at ~91% dead, and shakeup has never been measured on it, so every tree-shaking number we have is
// from the one shape where tree-shaking barely matters.
//
// This imports 8 names from three's 650KB ESM build and actually uses them, so the bundler has to
// discard the overwhelming majority: renderers, loaders, audio, animation, materials, curves, helpers.
// Deliberately a REALISTIC slice (math + a geometry + a mesh) rather than a synthetic single import —
// the interesting failures are cross-module retention, not the trivial case.
import { Box3, BoxGeometry, Color, Mesh, MeshBasicMaterial, Quaternion, Sphere, Vector3 } from 'three';

const position = new Vector3(1, 2, 3);
const rotation = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 4);
const tint = new Color(0x336699);

const geometry = new BoxGeometry(1, 1, 1);
const material = new MeshBasicMaterial({ color: tint });
const mesh = new Mesh(geometry, material);
mesh.position.copy(position);
mesh.quaternion.copy(rotation);
mesh.updateMatrixWorld(true);

const bounds = new Box3().setFromObject(mesh);
const sphere = new Sphere();
bounds.getBoundingSphere(sphere);

export const origin = position.toArray();
export const radius = sphere.radius;
export const centre = bounds.getCenter(new Vector3()).toArray();
export const hex = tint.getHexString();
