<h1 align="center">dsh-clawd</h1>

<div align="center">
  <img width="1116" height="263" alt="screenshot_20260928_004438" src="https://github.com/user-attachments/assets/5416ce24-7ba5-49bd-a010-1717cc981548" />
</div>

---

一只住在 **DSH Web GUI** 角落里的 Clawd。

## 依赖

- [DSH](https://github.com/deepseek-ai/deepseek-harness) `>= 0.1.7-rc.1`
- Node `^22.19.0 || >=24.0.0`

## 安装

```bash
dsh plugin --profile web add @mcxcc303/dsh-clawd
```

### GitHub 链接安装

```bash
dsh plugin --profile web add 'https://github.com/MCXCC303/dsh-clawd#main'
```

### 打包安装

```bash
npm run pack
dsh plugin --profile web add /path/to/dist/mcxcc303-dsh-clawd-0.1.0.tgz
```

## 主题安装

将 [clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk) 的主题放在 `$DSH_HOME/dsh-clawd/themes/` 或 `$DSH_HOME/dsh-clawd-themes/`，刷新页面后即可在设置中选择。

## LICENSE

MIT，覆盖本仓库的代码与独立素材（见 `LICENSE`）。

Clawd 角色（属 Anthropic）、Calico 猫（© 鹿鹿）等 `clawd-on-desk` 的任何素材均为 **All Rights Reserved**，本仓库不进行分发。

本项目是非官方同人作品，与 Anthropic 无任何关联。
