# mesh-to-tiles

支持 OBJ、glTF、 OSGB 倾斜摄影，转成 [3D Tiles 1.1](https://github.com/CesiumGS/3d-tiles)。

入口是同一个命令。`--input` 是文件时走 OBJ / glTF，输出隐式八叉树；是目录时走 OSGB，输出隐式四叉树。两种都默认输出 Draco 网格和 KTX2 ETC1S。

## 核心特性

| 特性 | 说明 |
| --- | --- |
| OBJ / glTF / GLB → 3D Tiles | 隐式八叉树，按模型包围盒自动生成 LOD，`refine` 为 `REPLACE`。GLB 可含 Draco |
| OSGB → 3D Tiles | 读取目录里的 `metadata.xml` 和 `.osgb`，沿 PagedLOD 生成隐式四叉树。只支持 WGS84 UTM（EPSG:326xx / 327xx） |
| 单张图集 | OBJ / glTF 每个瓦片重烘焙一张图集，UV 岛按原贴图重排；最细 4096，向上逐级减半，最低 128 |
| Draco 几何压缩 | 使用 `draco3dgltf` 编码，输出符合 `KHR_draco_mesh_compression`，材质 unlit、双面 |
| KTX2 纹理压缩 | 默认关闭，贴图是 JPEG，质量 75。`--texture-format ktx2` 后使用 ETC1S，质量 128，压缩力度 2，关闭 RDO。`--ktx2-uastc` 改用 UASTC。`--ktx2-zstd-level` 大于 0 时为 UASTC 打开 Zstandard。最多 16 个纹理同时编码 |
| 输出方向 | `--up` 是输出 glTF 的向上轴。不传时 OBJ、glTF、OSGB 都是 `y`，这是 Cesium 的正确方向 |
| 地理定位 | OBJ / glTF 用经度、纬度和椭球高定位局部原点 `(0,0,0)`。OSGB 用 `metadata.xml` 的 `SRSOrigin` 反算经纬度 |

## 技术栈

| 部分 | 使用 |
| --- | --- |
| 语言与运行时 | TypeScript，Node.js 18+ |
| glTF 读写与 Draco | `@gltf-transform/core`、`extensions`、`functions`，`draco3dgltf` |
| 贴图缩放与采样 | `sharp` |
| KTX2 | `@loaders.gl/textures` 中的 Basis Universal WASM，`worker_threads` 并行 |
| 瓦片格式 | 3D Tiles 1.1 implicit tiling，`KHR_draco_mesh_compression`，`KHR_materials_unlit`，可选 `KHR_texture_basisu` |

KTX2 编码在 CPU 上完成。Cesium 加载时再把 ETC1S 转成当前显卡的块压缩格式。

## 环境

- Node.js 18 或更高
- 带贴图的 `.obj`（含 `.mtl` 和 `map_Kd`），或带底色贴图的 `.glb` / `.gltf`
- 或一个 OSGB 目录：根上有 `metadata.xml` 和入口 `.osgb`，分页文件在子目录中

## 安装

```bash
npm install
npm run build
```

直接运行：

```bash
node dist/cli.js --input model.obj --output ./tiles
node dist/cli.js --input D:\terra_osgbs\terra_osgbs --output D:\terra_osgbs\tiles-quad
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
./mesh-to-tiles --input model.obj --output ./tiles --longitude 109.40 --latitude 34.03 --height 0
```

或链接到全局命令：

```bash
npm link
mesh-to-tiles --input model.obj --output ./tiles
```

## 用法

```bash
mesh-to-tiles --input model.glb --output ./tiles --longitude 109.40388330 --latitude 34.03154500 --height 0
mesh-to-tiles --input D:\terra_osgbs\terra_osgbs --output D:\terra_osgbs\tiles-quad
```

`--input` 指向文件时转换 OBJ / glTF，指向目录时转换 OSGB。共用 `--output`、`--up` 和 `--no-ktx2`。`--leaf-size`、`--leaf-error`、`--max-levels`、`--longitude`、`--latitude`、`--height` 只用于 OBJ / glTF，OSGB 会忽略它们。

不传 `--up` 时，OBJ、glTF 和 OSGB 都输出为 Y 轴向上。传了 `--up y` 或 `--up z` 就按传入的方向写，不区分输入格式。`y` 是 Cesium 的正确方向：Cesium 把 glTF 当作 Y 轴向上，再绕 X 轴转成东北天的 Z 轴向上。`--up z` 会把 Z 轴向上的坐标直接写入 glTF，Cesium 加载后模型会倒向一边。

瓦片包围盒和东北天变换始终是 Z 轴向上、单位米，不随 `--up` 改变。`--longitude`、`--latitude`、`--height` 是局部原点 `(0,0,0)` 的大地坐标，不会从网格里读取。`--height` 是该原点的 WGS84 椭球高，不是离地高度。经度和纬度要么一起传，要么都不传。

### 参数

| 参数 | 说明 | 默认 |
| --- | --- | --- |
| `--input` | `.obj`、`.glb`、`.gltf`，或含 `metadata.xml` 的 OSGB 目录 | 必填 |
| `--output` | 输出目录，每次运行会先清空 | 必填 |
| `--up y\|z` | 输出 glTF 的向上轴。OBJ、glTF、OSGB 相同 | `y` |
| `--leaf-size` | OBJ / glTF 最细格子边长，米 | `40` |
| `--leaf-error` | OBJ / glTF 最细层级的 `geometricError`，米 | `1` |
| `--max-levels` | OBJ / glTF 层级数上限 | `6` |
| `--longitude` | OBJ / glTF 局部原点经度，度 | 不写 |
| `--latitude` | OBJ / glTF 局部原点纬度，度 | 不写 |
| `--height` | OBJ / glTF 局部原点椭球高，米 | `0` |
| `--no-ktx2` | 强制 JPEG | 默认已是 JPEG |
| `--texture-format` | `jpeg`、`webp` 或 `ktx2` | `jpeg` |
| `--texture-quality` | JPEG / WebP 质量，1–100 | `75` |
| `--fine-texture-quality` | 最细一层的 JPEG / WebP 质量，0 表示沿用 `--texture-quality` | `0` |
| `--max-texture-size` | 贴图边长上限，0 表示不限制 | `4096` |
| `--ktx2-quality` | ETC1S 为 1–255，UASTC 为 0–4 | `128` |
| `--ktx2-uastc` | KTX2 使用 UASTC | 关闭 |
| `--ktx2-threads` | 同时编码的纹理数，0 为自动，最多 16。每张纹理仍是单线程 | `0` |
| `--ktx2-zstd-level` | UASTC 的 Zstandard，0 关闭，1–22 打开。此编码器不能指定具体等级 | `0` |
| `--ktx-level` | ETC1S 压缩力度，0–6 | `2` |

## OSGB

目录里需要 `metadata.xml`（`SRS` 或 `CoordSys`，以及 `SRSOrigin`）和至少一个 `.osgb`。`metadata.xml` 可以在传入目录、数据目录或上一级。坐标系只支持 WGS84 UTM，即 EPSG:326xx 或 EPSG:327xx。`SRSOrigin` 的东坐标、北坐标和高程会反算成经纬度和椭球高，写进根节点 `transform`。顶点已经是相对 `SRSOrigin` 的局部坐标。

输入目录会自动定位数据。目录本身没有 `.osgb` 时，会进入唯一的子目录，或名为 `Data` 的子目录。根文件按 `Data.osgb`、`tileset.osgb`、`Block.osgb` 的顺序选取。都没有时，如果文件名全是数字，用最短的那个作为根；否则读取该目录下的每一个 `.osgb`。子文件仍按 OSGB 里的相对路径打开。

OSGB 使用隐式四叉树，不使用八叉树。倾斜摄影的父子瓦片是在地面上分块的，八叉树还会把高度切成上下两半，替换时容易出现空块。子瓦片落在父格子的四个象限之一，用子网格中心相对父格子中心的平面位置决定。没有网格的根如果只有一个子节点，就折叠成第 0 层。根节点 `geometricError` 为 `2^最大层`。

贴图按离最细层的距离限制边长：最细层 2048，上一层 1024，更粗的层级 512。几何使用 Draco sequential，位置量化 14，纹理坐标量化 12。

压缩过的 OSGB，以及 UTM 以外的坐标系，目前不能转换。

## 输出

OBJ / glTF：

```text
tiles/
  tileset.json
  tiles/{level}/{x}/{y}/{z}.glb
  subtrees/0/0/0/0.subtree
```

OSGB：

```text
tiles/
  tileset.json
  tiles/{level}/{x}/{y}.glb
  subtrees/0/0/0.subtree
```

`tileset.json` 为 3D Tiles 1.1，`refine` 为 `REPLACE`。OBJ / glTF 的 `subdivisionScheme` 为 `OCTREE`，OSGB 为 `QUADTREE`。一个 subtree 覆盖全部层级。glTF 内容默认 Y 轴向上、unlit、Draco 压缩。底色贴图默认为 `image/ktx2`，并声明 `KHR_texture_basisu`。

默认贴图是 JPEG，质量 75。`--texture-format webp` 或 `ktx2` 才切换格式。层级 `L` 的 OBJ / glTF 图集边长为 `min(最大边长, max(128, 4096 / 2^(maxLevel - L)))`。OSGB 最细层 2048，上一层 1024，更粗为 512，同样受 `--max-texture-size` 限制。

## 许可

[MIT](LICENSE)
