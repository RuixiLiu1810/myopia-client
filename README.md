# Myopia Client

客户端仓：医生端 + 运维端 UI，仅通过 API 调用 server，不直连数据库。

## 目录

- `doctor_app/`
- `ops_console/`
- `apps/doctor/`、`apps/ops/`、`apps/shared/`
- `run_doctor.py`
- `run_ops.py`
- `launcher_server.py`

## 本地启动

```bash
python run_doctor.py --host 0.0.0.0 --port 8787 --backend-host 127.0.0.1 --backend-port 8000
python run_ops.py --host 0.0.0.0 --port 8788 --backend-host 127.0.0.1 --backend-port 8000
```

## 连接方式

- 登录页配置 `API Base URL`
- 生产建议固定 HTTPS 域名，不允许用户随意改动

## 约束

- 客户端不保存 DB 凭据
- 客户端不暴露模型目录/设备等运维配置
