# mesh-to-tiles

把带贴图的 OBJ 或 glTF 网格转成 [3D Tiles 1.1](https://github.com/CesiumGS/3d-tiles) 隐式八叉树。

每个瓦片是一个 Draco 网格加一张重烘焙的图集。最精细一层为 4096 像素，从原图采样；更粗的层级逐级减半，最低 128。图集默认编码为 KTX2 ETC1S。

## 核心特性

| 特性 | 说明 |
| --- | --- |
| OBJ / glTF / GLB → 3D Tiles | 隐式八叉树，按模型包围盒自动生成 LOD，`refine` 为 `REPLACE`。GLB 可含 Draco |
| 单张图集 | 每个瓦片重烘焙一张图集，UV 岛按原贴图重排；最细 4096，向上逐级减半，最低 128 |
| Draco 几何压缩 | 使用 `draco3dgltf` 编码，输出符合 `KHR_draco_mesh_compression`，材质 unlit、双面 |
| KTX2 纹理压缩 | 默认 ETC1S（Basis Universal，质量 128，无 mipmap），符合 `KHR_texture_basisu`；`worker_threads` 并行编码。`--no-ktx2` 改为 PNG |
| 地理定位 | 经度、纬度、椭球高定位局部原点 `(0,0,0)`。`--up` 表示输入模型的向上轴 |

## 技术栈

| 部分 | 使用 |
| --- | --- |
| 语言与运行时 | TypeScript，Node.js 18+ |
| glTF 读写与 Draco | `@gltf-transform/core`、`extensions`、`functions`，`draco3dgltf` |
| 贴图缩放与采样 | `sharp` |
| KTX2 | `@loaders.gl/textures` 中的 Basis Universal WASM，`worker_threads` 并行 |
| 瓦片格式 | 3D Tiles 1.1 implicit octree，`KHR_draco_mesh_compression`，`KHR_materials_unlit`，可选 `KHR_texture_basisu` |

KTX2 编码在 CPU 上完成。Cesium 加载时再把 ETC1S 转成当前显卡的块压缩格式。

## 环境

- Node.js 18 或更高
- 带贴图的 `.obj`（含 `.mtl` 和 `map_Kd`），或带底色贴图的 `.glb` / `.gltf`

## 安装

```bash
npm install
npm run build
```

直接运行：

```bash
node dist/cli.js --input model.obj --output ./tiles
```

## 发布包

其他项目不需要安装 Node，也不需要再执行 `npm install`。按平台各打一份：

```bash
npm run pack:win
npm run pack:linux
```

产物在 `release/mesh-to-tiles-win-x64` 和 `release/mesh-to-tiles-linux-x64`。目录里的 `node`、`sharp` 和 WASM 要一起拷贝。Linux 包在 glibc 系统上使用，例如 Ubuntu。

Windows：

```text
mesh-to-tiles.cmd --input model.obj --output ./tiles --longitude 109.40 --latitude 34.03 --height 0
```

Linux：

```bash
chmod +x mesh-to-tiles
./mesh-to-tiles --input model.obj --output ./tiles --up z --longitude 109.40 --latitude 34.03 --height 0
```

或链接到全局命令：

```bash
npm link
mesh-to-tiles --input model.obj --output ./tiles
```

## 用法

```bash
mesh-to-tiles --input model.glb --output ./tiles --longitude 109.40388330 --latitude 34.03154500 --height 0
```

`--up` 只描述输入模型的向上轴，不改变输出方向。OBJ 默认 `z`，glTF / GLB 默认 `y`。ODM 导出的 OBJ 和 GLB 顶点都是 Z 轴向上，OBJ 可以不写，GLB 要写 `--up z`。

输出固定为两套坐标：瓦片局部坐标是 Z 轴向上、单位米；瓦片内的 glTF 按规范写成 Y 轴向上，Cesium 加载时会转回 Z 轴向上。`--longitude`、`--latitude`、`--height` 是局部原点 `(0,0,0)` 的大地坐标，不会从网格里读取。`--height` 是该原点的 WGS84 椭球高，不是离地高度。顶点原来的 Z 会保留。

### 参数

| 参数 | 说明 | 默认 |
| --- | --- | --- |
| `--input` | `.obj`、`.glb` 或 `.gltf` | 必填 |
| `--output` | 输出目录，每次运行会先清空 | 必填 |
| `--up z\|y` | 输入模型的向上轴 | OBJ 为 `z`，glTF / GLB 为 `y` |
| `--leaf-size` | 最细格子边长，米 | `40` |
| `--leaf-error` | 最细层级的 `geometricError`，米 | `1` |
| `--max-levels` | 层级数上限 | `6` |
| `--longitude` | 局部原点经度，度 | 不写 |
| `--latitude` | 局部原点纬度，度 | 不写 |
| `--height` | 局部原点椭球高，米 | `0` |
| `--no-ktx2` | 图集保持 PNG，不编码 KTX2 | KTX2 开启 |

经度和纬度要么一起传，要么都不传。

## 输出

```text
tiles/
  tileset.json
  tiles/{level}/{x}/{y}/{z}.glb
  subtrees/0/0/0/0.subtree
```

`tileset.json` 为 3D Tiles 1.1，`subdivisionScheme` 为 `OCTREE`，`refine` 为 `REPLACE`。一个 subtree 覆盖全部层级。glTF 内容为 Y 轴向上、unlit、Draco 压缩。底色贴图默认为 `image/ktx2`，并声明 `KHR_texture_basisu`。`--no-ktx2` 时贴图为 PNG。

层级 `L` 的图集边长为 `max(128, 4096 / 2^(maxLevel - L))`。只有 4096 那一层按原图分辨率采样，更小的层级先缩到 2048 再采样。

## 许可

[MIT](LICENSE)
