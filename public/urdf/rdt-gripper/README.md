# RDT data-collection gripper

This local asset powers the `3D Replay` view for datasets whose `robot_type` is
`bi_rdt_gripper`.

- `gripper.urdf` is a sanitized, project-local copy of the vendor's SolidWorks
  URDF export of the **CTAG2F120** two-finger gripper (ROS package
  `crt_ctag2f120_gripper_visualization`, exporter 1.6.0, 2023-09).
- **One file, both arms.** `Left_*` and `Right_*` in this model are the two
  _jaws_ of a single gripper, not two arms, so the viewer instantiates the same
  URDF once per recorded side. TacCap needs two files; this does not.
- Mesh references are relative, so runtime loading never depends on a ROS
  package path or on files outside this repository. `<inertial>`, `<collision>`
  and the launch/config/script files are dropped — this is a visualisation
  asset, not a runnable ROS package. The joint tree, origins, axes, limits and
  mimics are byte-for-byte the vendor's; only the packaging changed.
- `R2` is the single driven joint, `0` → `0.7 rad`. The other 13 joints mimic it
  directly or transitively, so the whole jaw follows from one value. The
  recorded `{side}_gripper.pos` is normalized `0..1` and maps onto that range.
- The `shell` / `finger` materials exist because URDFLoader overwrites whatever
  material the mesh callback sets; without them the model renders untextured.
  The finger colour is tinted per side at load time to match the trajectory
  trail, which the per-side TacCap files bake in instead.

## The TCP transform is derived, not measured

⚠️ Unlike TacCap — whose `base_link -> link4` translation is a measured number
copied from the collector's `ee_transform.py` — **no measured `base_link -> TCP`
transform exists for this gripper**. It is absent from `xense-taccap-lerobot`
(which does not mention `ctag2f120` at all), there is no `taccap_extrinsics.json`
in the RDT datasets, and the raw HDF5 the datasets were converted from ships no
calibration.

What `src/utils/bundledGrippers.ts` uses instead is read off this model's own
forward kinematics:

- **translation** — walking `R2 -> Right_in -> Right_Pad` and its left mirror
  puts the jaw pads at `z = +0.2572 m` with a 2 mm gap at `R2 = 0`, opening to
  88 mm at `R2 = 0.7`. The jaw midpoint is the natural TCP for a parallel
  gripper.
- **rotation** — the model approaches along its own `+Z` and opens along `±X`;
  the viewer's canonical TCP frame is `+X forward, +Y left, +Z up`. Aligning
  them is the axis cycle `X_tcp = +Z_model`, `Y_tcp = +X_model`,
  `Z_tcp = +Y_model`.

The rotation is the fragile half, and it fails visibly: a wrong cycle shows up
as a gripper approaching sideways, or a body detached from its own trail. Both
are a one-constant fix in `bundledGrippers.ts`. **Replace both values the moment
a measured transform exists.**
