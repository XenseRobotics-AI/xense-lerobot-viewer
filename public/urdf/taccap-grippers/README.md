# TacCap data-collection grippers

These local assets power the `3D Replay` view for datasets whose
`robot_type` is `bi_taccap_gripper`.

- `urdf/taccap_g1_master_{left,right}.urdf` and `meshes/{left,right}/` are
  **verbatim copies** of `ros/taccap_master_description/` in
  [XTac-UMI-Description](https://github.com/XenseRobotics-AI/XTac-UMI-Description)
  at `f2d701e`, laid out the same way so the URDFs' `../meshes/<side>/` paths
  resolve unchanged. That repository is the source of truth for frames and
  names; to update, copy both directories again rather than editing here.
- The models are rooted on the shell rear surface with **+Z along the tool
  axis** and +Y toward the left finger. Every name is side-prefixed:
  `<side>_eef_link` is the EEF (centre of the closed fingertips' distal face),
  `<side>_right_joint` is the driven finger, and `<side>_left_joint` mimics it
  with multiplier `-1`, over `0` to `28.92°` (`0.5047492196767601 rad`).
- The viewer reads `left_tcp` / `right_tcp` as the canonical TCP frame
  `+X forward, +Y left, +Z up`, so it places the model root with a fixed axis
  turn (`X_tcp = +Z`, `Y_tcp = +Y`, `Z_tcp = -X`) plus the `<side>_eef_joint`
  translation; see `src/utils/taccapGripperTransforms.ts`.
- These replaced SolidWorks exports of the same meshes (`{side}/gripper.urdf`,
  rooted at the CAD frame, with `link4` as the TCP). Re-rooting moved the root,
  not the gripper: the two place every mesh within 0.08 mm of each other, and a
  test holds that.
