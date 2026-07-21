// cockpit.js — first-person cockpit interior.
//
// Built in code rather than reused from the exported airframe. The external
// model is designed to be seen from outside: its canopy is a closed shell and
// its "interior" is a seat block and a coaming placed to read at chase-camera
// distance. Sitting a camera inside it would put you behind opaque geometry
// with nothing sensibly framed. A purpose-built interior is also what real
// flight games ship, for exactly this reason.
//
// The whole assembly is parented to the CAMERA, not the aircraft. In the
// cockpit the pilot and the airframe move as one, so anything attached to the
// camera is automatically correct — including under camera shake, where a
// cockpit rigidly fixed to the jet would visibly slide against the view.
import * as THREE from 'three';

/** Where the pilot's eye sits in the aircraft's local frame (forward = +Z). */
export const EYE_OFFSET = new THREE.Vector3(0, 1.02, 1.45);

function frameMat(color, rough = 0.62, metal = 0.35) {
  return new THREE.MeshStandardMaterial({
    color, roughness: rough, metalness: metal,
    // FrontSide, deliberately. DoubleSide on a camera-attached object renders
    // interior backfaces, whose normals point away from every light — they
    // shade to pure black and fill whatever part of the view they cover with a
    // hard-edged dark mass. Backface culling makes that impossible.
    side: THREE.FrontSide,
    // A small emissive floor so no panel can reach absolute black even with the
    // sun behind it. Cockpit interiors are lit by instrument spill in reality.
    emissive: new THREE.Color(color).multiplyScalar(0.35),
    emissiveIntensity: 0.5,
  });
}

/**
 * Build the interior. Dimensions are in camera-local units at the near end of
 * the view, so everything is small — it sits roughly 0.35–1.2 units in front of
 * the eye, well clear of the 2.0 near plane once scaled.
 */
export function createCockpit() {
  const root = new THREE.Group();
  root.name = 'CockpitInterior';

  const dark = frameMat(0x1b2027, 0.7, 0.25);
  const panel = frameMat(0x12161b, 0.85, 0.1);
  const trim = frameMat(0x2a323c, 0.55, 0.5);

  // Layout is derived from the frustum, not guessed. At FOV ~70° the half-angle
  // is 35°, so a feature at distance d and height y lands at |y| / (d*tan35°)
  // of half-screen. Everything below is placed from that relation: the earlier
  // pass put the glare shield at 18% below centre, where it read as a black bar
  // across the middle of the view, and an arch that swallowed the top third.

  // ---- Coaming: dark shroud along the bottom, top edge ~28% below centre ---
  const coamShape = new THREE.Shape();
  coamShape.moveTo(-1.55, 0);
  coamShape.quadraticCurveTo(0, 0.17, 1.55, 0);
  coamShape.lineTo(1.55, -0.70);
  coamShape.lineTo(-1.55, -0.70);
  coamShape.closePath();
  const coaming = new THREE.Mesh(
    new THREE.ExtrudeGeometry(coamShape, { depth: 0.34, bevelEnabled: true,
      bevelThickness: 0.015, bevelSize: 0.015, bevelSegments: 2 }),
    dark);
  coaming.position.set(0, -0.66, -1.30);
  root.add(coaming);

  // Glare shield lip, sitting ON the coaming rather than floating above it.
  const lip = new THREE.Mesh(new THREE.BoxGeometry(3.02, 0.035, 0.13), trim);
  lip.position.set(0, -0.505, -1.24);
  lip.rotation.x = -0.20;
  root.add(lip);

  // ---- Instrument panel, angled back toward the pilot ---------------------
  const ip = new THREE.Mesh(new THREE.BoxGeometry(2.30, 0.70, 0.05), panel);
  ip.position.set(0, -0.99, -1.16);
  ip.rotation.x = 0.40;
  root.add(ip);

  const mfdGlass = new THREE.MeshStandardMaterial({
    color: 0x0a1a18, emissive: 0x0d3a33, emissiveIntensity: 0.6,
    roughness: 0.35, metalness: 0.1,
  });
  for (const [x, w2, h2] of [[-0.66, 0.42, 0.34], [0, 0.46, 0.38], [0.66, 0.42, 0.34]]) {
    const bezel = new THREE.Mesh(new THREE.BoxGeometry(w2 + 0.05, h2 + 0.05, 0.025), trim);
    bezel.position.set(x, -0.975, -1.145);
    bezel.rotation.x = 0.40;
    root.add(bezel);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(w2, h2), mfdGlass);
    screen.position.set(x, -0.970, -1.133);
    screen.rotation.x = 0.40;
    root.add(screen);
  }

  // ---- Canopy frame -------------------------------------------------------
  // Wide and thin. The arch is pushed out and up so only its lower legs are in
  // frame — a bow drawn across the top of the screen is what made the previous
  // version feel like looking out of a letterbox.
  const bow = new THREE.Mesh(
    new THREE.TorusGeometry(1.72, 0.022, 8, 48, Math.PI), dark);
  bow.position.set(0, -0.30, -1.44);
  bow.rotation.x = 0.06;
  root.add(bow);

  for (const sx of [-1, 1]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.030, 0.030, 1.5), dark);
    rail.position.set(sx * 1.52, -0.26, -0.72);
    rail.rotation.y = sx * 0.09;
    rail.rotation.z = sx * -0.05;
    root.add(rail);

    const side = new THREE.Mesh(new THREE.BoxGeometry(0.40, 0.05, 1.0), panel);
    side.position.set(sx * 1.30, -0.90, -0.70);
    side.rotation.z = sx * 0.14;
    root.add(side);
  }

  // The canopy glass was removed. At 5% opacity it added nothing visible, but
  // it was a large double-sided surface enclosing the viewpoint — exactly the
  // shape that renders as an unlit black dome if anything about the culling or
  // depth state is off. Not worth the risk for an invisible tint.

  root.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
  // Drawn after the world so it always occludes correctly at the near plane.
  root.renderOrder = 2;
  return root;
}
