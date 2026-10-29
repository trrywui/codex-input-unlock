use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    env,
    fs::{self, File, OpenOptions},
    io::{self, BufRead, BufReader, Read, Write},
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream},
    os::{
        fd::{AsRawFd, RawFd},
        unix::{
            fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
            net::{UnixListener, UnixStream},
        },
    },
    path::{Path, PathBuf},
    process::{Command, ExitCode},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tungstenite::{protocol::WebSocketConfig, Error as WsError, Message, WebSocket};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
const OWNER: &str = "io.github.trrywui.codex-input-unlock";
const VERSION: &str = "0.3.3";
const MAX_MESSAGE: usize = 64 * 1024 * 1024;
fn error(text: impl Into<String>) -> Box<dyn std::error::Error> {
    io::Error::other(text.into()).into()
}
fn strv<'a>(v: &'a Value, name: &str) -> &'a str {
    v.get(name).and_then(Value::as_str).unwrap_or("")
}
fn composer_refresh(manifest: &Value) -> Option<String> {
    let component = manifest["location"]["componentName"].as_str()?;
    let expression = r#"(() => {
        if (typeof document === 'undefined') return 0;
        const visited = new Set();
        let refreshed = 0;
        const roots = document.querySelectorAll('[data-codex-composer-root]');
        for (const root of roots) {
            const property = Object.keys(root).find(name => name.startsWith('__reactFiber$'));
            let fiber = root[property];
            for (let depth = 0; fiber && depth < 100; depth++, fiber = fiber.return) {
                if (fiber.type?.name !== __COMPONENT__) continue;
                if (visited.has(fiber)) break;
                visited.add(fiber);
                const hooks = [];
                for (let hook = fiber.memoizedState; hook; hook = hook.next) {
                    if (hook.memoizedState instanceof Set && typeof hook.queue?.dispatch === 'function') hooks.push(hook);
                }
                if (hooks.length !== 1) throw Error('本地编辑器缓存刷新未唯一定位');
                hooks[0].queue.dispatch(new Set(hooks[0].memoizedState));
                refreshed++;
                break;
            }
        }
        if (roots.length && !refreshed) throw Error('本地编辑器组件未定位');
        return new Promise(resolve => setTimeout(() => resolve(refreshed), 0));
    })()"#;
    Some(expression.replace("__COMPONENT__", &json!(component).to_string()))
}
fn read_json(path: &Path) -> Result<Value> {
    Ok(serde_json::from_slice(&fs::read(path)?)?)
}
fn write_json(path: &Path, value: &Value) -> Result<()> {
    let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
    let mut f = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&tmp)?;
    serde_json::to_writer(&mut f, value)?;
    f.write_all(b"\n")?;
    drop(f);
    fs::rename(tmp, path)?;
    Ok(())
}
fn verify_dir(dir: &Path, create: bool) -> Result<bool> {
    if !dir.exists() {
        if !create {
            return Ok(false);
        }
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)?;
        write_json(&dir.join("owner.json"), &json!({"tool":OWNER,"format":1}))?;
    }
    let meta = fs::symlink_metadata(dir)?;
    if !meta.is_dir()
        || meta.file_type().is_symlink()
        || strv(&read_json(&dir.join("owner.json"))?, "tool") != OWNER
    {
        return Err(error("数据目录不属于原型或是符号链接，拒绝访问"));
    }
    Ok(true)
}
fn lock(dir: &Path, name: &str) -> Result<File> {
    let f = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(dir.join(name))?;
    if unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(error("原型后台或启动操作已在运行"));
    }
    Ok(f)
}
fn proc_path(pid: i32) -> Option<String> {
    let mut b = [0u8; 4096];
    let n = unsafe { libc::proc_pidpath(pid, b.as_mut_ptr().cast(), b.len() as u32) };
    if n <= 0 {
        return None;
    }
    Some(
        String::from_utf8_lossy(&b[..b.iter().position(|&c| c == 0).unwrap_or(b.len())])
            .into_owned(),
    )
}
fn main_pid(app: &str, executable: &str) -> Result<i32> {
    let count = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
    if count <= 0 {
        return Err(error("无法枚举目标客户端进程"));
    }
    let mut ids = vec![0i32; count as usize + 256];
    let actual = unsafe { libc::proc_listallpids(ids.as_mut_ptr().cast(), (ids.len() * 4) as i32) };
    ids.into_iter()
        .take(actual.max(0) as usize)
        .find(|&pid| {
            proc_path(pid).as_deref() == Some(executable)
                && executable.starts_with(&format!("{app}/Contents/"))
        })
        .ok_or_else(|| error("未找到目标主进程"))
}
fn condition(location: &Value) -> Result<String> {
    fn identifier(s: &str) -> bool {
        !s.is_empty()
            && s.bytes().enumerate().all(|(i, b)| {
                b.is_ascii_alphabetic() || b == b'_' || b == b'$' || i > 0 && b.is_ascii_digit()
            })
    }
    let q = strv(location, "quotaVariable");
    if !identifier(q) {
        return Err(error("额度变量无效"));
    }
    match strv(location, "mode") {
        "local-submit-quota" | "codex-local-quota" | "legacy-local-host" => {
            Ok(format!("({q}=false,false)"))
        }
        "third-party-composer-dual" | "conditional-composer-dual" => {
            let c = strv(location, "conversationQuotaVariable");
            if !identifier(c) {
                return Err(error("会话变量无效"));
            }
            Ok(format!("({c}=false,{q}=false,false)"))
        }
        _ => Err(error("不支持的额度结构")),
    }
}
fn validate_manifest(v: &Value) -> Result<()> {
    if condition(&v["location"])? != strv(v, "condition")
        || strv(v, "bundleSha256").len() != 64
        || !strv(v, "bundleSha256")
            .bytes()
            .all(|b| b.is_ascii_hexdigit())
    {
        return Err(error("预检清单无效"));
    }
    for key in ["lineNumber", "columnNumber"] {
        if v["location"][key].as_u64().is_none() {
            return Err(error("预检坐标无效"));
        }
    }
    if !strv(v, "url").starts_with("app://-/assets/") || !strv(v, "url").ends_with(".js") {
        return Err(error("预检脚本 URL 无效"));
    }
    Ok(())
}
fn ws_address(url: &str, expected_port: Option<u16>) -> Result<SocketAddr> {
    let rest = url
        .strip_prefix("ws://")
        .ok_or_else(|| error("只接受本机 ws 地址"))?;
    let (authority, path) = rest
        .split_once('/')
        .ok_or_else(|| error("WebSocket 路径缺失"))?;
    if path.contains('#') || path.contains('\r') || path.contains('\n') {
        return Err(error("WebSocket 路径无效"));
    }
    let (host, port) = authority
        .rsplit_once(':')
        .ok_or_else(|| error("端口缺失"))?;
    let port: u16 = port.parse()?;
    if port == 0 || expected_port.is_some_and(|p| p != port) {
        return Err(error("调试端口不符"));
    }
    let ip = match host {
        "127.0.0.1" => IpAddr::V4(Ipv4Addr::LOCALHOST),
        "[::1]" => IpAddr::V6(Ipv6Addr::LOCALHOST),
        _ => return Err(error("CDP 地址不是回环地址")),
    };
    Ok(SocketAddr::new(ip, port))
}
fn connect_ws(url: &str, port: Option<u16>) -> Result<WebSocket<TcpStream>> {
    let addr = ws_address(url, port)?;
    let stream = TcpStream::connect_timeout(&addr, Duration::from_secs(4))?;
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    let config = WebSocketConfig::default()
        .read_buffer_size(16 * 1024)
        .write_buffer_size(0)
        .max_message_size(Some(MAX_MESSAGE))
        .max_frame_size(Some(MAX_MESSAGE));
    let (ws, _) = tungstenite::client::client_with_config(url, stream, Some(config))?;
    ws.get_ref().set_read_timeout(None)?;
    ws.get_ref().set_write_timeout(None)?;
    ws.get_ref().set_nonblocking(true)?;
    Ok(ws)
}
fn http_version(port: u16) -> Result<Value> {
    let mut stream = TcpStream::connect_timeout(
        &SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port),
        Duration::from_millis(500),
    )?;
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    write!(
        stream,
        "GET /json/version HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    )?;
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    if !line.starts_with("HTTP/1.1 200") && !line.starts_with("HTTP/1.0 200") {
        return Err(error("CDP 版本端点尚未就绪"));
    }
    let mut length = None;
    let mut total = 0;
    loop {
        line.clear();
        reader.read_line(&mut line)?;
        total += line.len();
        if total > 65536 || line.is_empty() {
            return Err(error("HTTP 头部无效"));
        }
        if line == "\r\n" {
            break;
        }
        if let Some((key, value)) = line.split_once(':') {
            if key.eq_ignore_ascii_case("content-length") {
                length = Some(value.trim().parse::<usize>()?);
            }
            if key.eq_ignore_ascii_case("transfer-encoding") {
                return Err(error("不支持的 HTTP 编码"));
            }
        }
    }
    let mut data = Vec::new();
    if let Some(length) = length {
        if length > 2 * 1024 * 1024 {
            return Err(error("HTTP 数据过大"));
        }
        data.resize(length, 0);
        reader.read_exact(&mut data)?;
    } else {
        reader.take(2 * 1024 * 1024 + 1).read_to_end(&mut data)?;
    }
    if data.len() > 2 * 1024 * 1024 {
        return Err(error("HTTP 数据过大"));
    }
    Ok(serde_json::from_slice(&data)?)
}
fn verify_listener(port: u16, manifest: &Value) -> Result<i32> {
    let app = strv(manifest, "app");
    let exe = strv(manifest, "executable");
    if app.is_empty() || exe.is_empty() {
        return Err(error("目标应用信息缺失"));
    }
    let output = Command::new("/usr/sbin/lsof")
        .args([
            "-nP",
            "-a",
            &format!("-iTCP:{port}"),
            "-sTCP:LISTEN",
            "-Fpn",
        ])
        .output()?;
    if !output.status.success() {
        return Err(error("无法确认调试端口归属"));
    }
    let mut pid = 0;
    let mut found = 0;
    for line in String::from_utf8(output.stdout)?.lines() {
        if let Some(value) = line.strip_prefix('p') {
            pid = value.parse()?;
        }
        if let Some(value) = line.strip_prefix('n') {
            if (value != format!("127.0.0.1:{port}") && value != format!("[::1]:{port}"))
                || !proc_path(pid).is_some_and(|p| p.starts_with(&format!("{app}/Contents/")))
            {
                return Err(error("调试端口不属于目标应用或并非回环监听"));
            }
            found += 1;
        }
    }
    if found == 0 {
        return Err(error("未发现调试监听"));
    }
    main_pid(app, exe)
}
fn write_line(stream: &mut UnixStream, value: &Value) -> Result<()> {
    serde_json::to_writer(&mut *stream, value)?;
    stream.write_all(b"\n")?;
    Ok(())
}
fn read_line(stream: &mut UnixStream) -> Result<Value> {
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    let mut data = Vec::new();
    let n = BufReader::new(stream.take(65537)).read_until(b'\n', &mut data)?;
    if n == 0 || n > 65536 || data.last() != Some(&b'\n') {
        return Err(error("控制消息无效"));
    }
    Ok(serde_json::from_slice(&data)?)
}
fn control(dir: &Path, command: &str) -> Result<Value> {
    if !verify_dir(dir, false)? {
        return Err(error("原型尚未运行"));
    }
    let state = read_json(&dir.join("state.json"))?;
    let mut stream = UnixStream::connect(dir.join("control.sock"))?;
    write_line(
        &mut stream,
        &json!({"token":strv(&state,"token"),"command":command}),
    )?;
    read_line(&mut stream)
}
fn status(dir: &Path) -> Result<Value> {
    if !verify_dir(dir, false)? {
        return Ok(json!({"state":"not-started","backend":"Rust","running":false}));
    }
    if let Ok(value) = control(dir, "status") {
        return Ok(value);
    }
    let mut value = read_json(&dir.join("state.json")).unwrap_or(json!({}));
    value.as_object_mut().unwrap().remove("token");
    value["running"] = false.into();
    if !matches!(strv(&value, "state"), "stopped" | "failed") {
        value["state"] = "not-running".into();
    }
    Ok(value)
}
fn stop(dir: &Path) -> Result<Value> {
    if verify_dir(dir, false)? && control(dir, "stop").is_ok() {
        let until = Instant::now() + Duration::from_secs(8);
        while control(dir, "status").is_ok() {
            if Instant::now() > until {
                return Err(error("停止尚未确认"));
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    Ok(json!({"state":"stopped","message":"原型断点已清理，官方客户端未关闭"}))
}
struct ControlServer {
    listener: UnixListener,
    path: PathBuf,
}
impl ControlServer {
    fn new(dir: &Path) -> Result<Self> {
        let path = dir.join("control.sock");
        if path.as_os_str().as_encoded_bytes().len() >= 104 {
            return Err(error("控制套接字路径太长，请使用较短测试目录"));
        }
        if let Ok(meta) = fs::symlink_metadata(&path) {
            use std::os::unix::fs::FileTypeExt;
            if !meta.file_type().is_socket() {
                return Err(error("控制路径被其它文件占用"));
            }
            fs::remove_file(&path)?;
        }
        let listener = UnixListener::bind(&path)?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
        listener.set_nonblocking(true)?;
        Ok(Self { listener, path })
    }
}
impl Drop for ControlServer {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}
struct Poll {
    fd: RawFd,
}
impl Poll {
    fn new() -> Result<Self> {
        let fd = unsafe { libc::kqueue() };
        if fd < 0 {
            return Err(io::Error::last_os_error().into());
        }
        Ok(Self { fd })
    }
    fn change(&self, id: usize, filter: i16, flags: u16, fflags: u32) -> Result<()> {
        let event = libc::kevent {
            ident: id,
            filter,
            flags,
            fflags,
            data: 0,
            udata: std::ptr::null_mut(),
        };
        if unsafe {
            libc::kevent(
                self.fd,
                &event,
                1,
                std::ptr::null_mut(),
                0,
                std::ptr::null(),
            )
        } < 0
        {
            return Err(io::Error::last_os_error().into());
        }
        Ok(())
    }
    fn read(&self, fd: RawFd) -> Result<()> {
        self.change(
            fd as usize,
            libc::EVFILT_READ,
            libc::EV_ADD | libc::EV_CLEAR,
            0,
        )
    }
    fn wait(&self, until: Option<Instant>) -> Result<Vec<libc::kevent>> {
        let timeout = until
            .map(|t| t.saturating_duration_since(Instant::now()))
            .map(|d| libc::timespec {
                tv_sec: d.as_secs() as _,
                tv_nsec: d.subsec_nanos() as _,
            });
        let mut events = vec![unsafe { std::mem::zeroed::<libc::kevent>() }; 16];
        let n = unsafe {
            libc::kevent(
                self.fd,
                std::ptr::null(),
                0,
                events.as_mut_ptr(),
                events.len() as i32,
                timeout.as_ref().map_or(std::ptr::null(), |p| p),
            )
        };
        if n < 0 {
            let e = io::Error::last_os_error();
            if e.kind() == io::ErrorKind::Interrupted {
                return Ok(Vec::new());
            }
            return Err(e.into());
        }
        events.truncate(n as usize);
        Ok(events)
    }
}
impl Drop for Poll {
    fn drop(&mut self) {
        unsafe {
            libc::close(self.fd);
        }
    }
}
#[derive(Clone)]
enum Kind {
    Other,
    Ignore,
    Scoped(String, u64),
    Attach(String),
    Source(String, u64),
    Positions(String, u64, String),
    Mounted(String, u64),
    Refreshed(String, u64),
    Cleanup,
}
struct Request {
    kind: Kind,
    until: Instant,
}
#[derive(Default)]
struct Renderer {
    session: Option<String>,
    generation: u64,
    scripts: BTreeSet<String>,
    breakpoint: Option<String>,
    ready: bool,
}
struct Agent {
    dir: PathBuf,
    manifest: Value,
    token: String,
    server: ControlServer,
    _lock: File,
    poll: Poll,
    ws: Option<WebSocket<TcpStream>>,
    write_watched: bool,
    next_id: u64,
    requests: BTreeMap<u64, Request>,
    renderers: BTreeMap<String, Renderer>,
    targets: BTreeSet<String>,
    attaching: BTreeSet<String>,
    retry: BTreeMap<String, Instant>,
    direct: bool,
    watch_pid: Option<i32>,
    stopping: bool,
    failure: Option<String>,
    stop_until: Option<Instant>,
    startup_until: Option<Instant>,
    state: Value,
    comparison: Value,
}
impl Agent {
    fn new(dir: PathBuf, manifest: Value, direct: bool) -> Result<Self> {
        validate_manifest(&manifest)?;
        verify_dir(&dir, true)?;
        let lock = lock(&dir, "agent.lock")?;
        let server = ControlServer::new(&dir)?;
        let poll = Poll::new()?;
        poll.read(server.listener.as_raw_fd())?;
        for sig in [libc::SIGTERM, libc::SIGINT] {
            unsafe {
                libc::signal(sig, libc::SIG_IGN);
            }
            poll.change(
                sig as usize,
                libc::EVFILT_SIGNAL,
                libc::EV_ADD | libc::EV_CLEAR,
                0,
            )?;
        }
        let mut random = [0u8; 16];
        File::open("/dev/urandom")?.read_exact(&mut random)?;
        let token = random.iter().map(|b| format!("{b:02x}")).collect();
        Ok(Self {
            dir,
            manifest,
            token,
            server,
            _lock: lock,
            poll,
            ws: None,
            write_watched: false,
            next_id: 0,
            requests: BTreeMap::new(),
            renderers: BTreeMap::new(),
            targets: BTreeSet::new(),
            attaching: BTreeSet::new(),
            retry: BTreeMap::new(),
            direct,
            watch_pid: None,
            stopping: false,
            failure: None,
            stop_until: None,
            startup_until: Some(Instant::now() + Duration::from_secs(60)),
            state: json!({}),
            comparison: Value::Null,
        })
    }
    fn update(&mut self, value: &str) -> Result<()> {
        let windows: Vec<Value> = self
            .renderers
            .iter()
            .map(|(id, r)| json!({"id":id,"ready":r.ready}))
            .collect();
        let mut state = json!({"state":value,"pid":std::process::id(),"backend":"Rust","version":VERSION,"windows":windows});
        if let Some(failure) = &self.failure {
            state["error"] = failure.clone().into();
        }
        if state == self.comparison {
            return Ok(());
        }
        self.comparison = state.clone();
        state["token"] = self.token.clone().into();
        state["updatedAt"] = json!(SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs());
        write_json(&self.dir.join("state.json"), &state)?;
        self.state = state;
        Ok(())
    }
    fn report(&mut self) -> Result<()> {
        if self.stopping {
            return Ok(());
        }
        let ready = !self.renderers.is_empty()
            && self.attaching.is_empty()
            && self.renderers.values().all(|r| r.ready);
        if ready {
            self.startup_until = None;
        }
        self.update(if ready { "ready" } else { "waiting" })
    }
    fn public(&self) -> Value {
        let mut state = self.state.clone();
        state.as_object_mut().unwrap().remove("token");
        state["running"] = (!self.stopping).into();
        state
    }
    fn serve(&mut self) -> Result<()> {
        loop {
            let (mut stream, _) = match self.server.listener.accept() {
                Ok(v) => v,
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                Err(e) => return Err(e.into()),
            };
            stream.set_nonblocking(false)?;
            let request = match read_line(&mut stream) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if strv(&request, "token") != self.token {
                continue;
            }
            if strv(&request, "command") == "stop" {
                let _ = write_line(&mut stream, &json!({"state":"stopping"}));
                self.begin_stop(None)?;
            } else {
                let _ = write_line(&mut stream, &self.public());
            }
        }
        Ok(())
    }
    fn watch(&mut self, pid: i32) -> Result<()> {
        self.poll.change(
            pid as usize,
            libc::EVFILT_PROC,
            libc::EV_ADD | libc::EV_ONESHOT,
            libc::NOTE_EXIT,
        )?;
        self.watch_pid = Some(pid);
        Ok(())
    }
    fn start_ws(&mut self, url: &str) -> Result<()> {
        let port = self.manifest["port"].as_u64().map(|n| n as u16);
        let ws = connect_ws(url, port)?;
        self.poll.read(ws.get_ref().as_raw_fd())?;
        self.ws = Some(ws);
        if self.direct {
            self.add_renderer("probe".into(), None)?;
        } else {
            self.send(
                "Target.setDiscoverTargets",
                json!({"discover":true}),
                None,
                Kind::Other,
            )?;
        }
        Ok(())
    }
    fn bootstrap(&mut self) -> Result<()> {
        self.update("waiting")?;
        let port = self.manifest["port"]
            .as_u64()
            .filter(|&p| p > 0 && p <= 65535)
            .ok_or_else(|| error("端口无效"))? as u16;
        let mut delay = Duration::from_millis(100);
        loop {
            if self.stopping {
                return Ok(());
            }
            self.serve()?;
            if let Ok(info) = http_version(port) {
                let url = strv(&info, "webSocketDebuggerUrl");
                ws_address(url, Some(port))?;
                let pid = verify_listener(port, &self.manifest)?;
                self.watch(pid)?;
                self.start_ws(url)?;
                return Ok(());
            }
            if Instant::now() > self.startup_until.unwrap() {
                return Err(error("CDP 启动超时"));
            }
            for event in self.poll.wait(Some(Instant::now() + delay))? {
                if event.filter == libc::EVFILT_SIGNAL {
                    self.begin_stop(None)?;
                } else if event.filter == libc::EVFILT_READ {
                    self.serve()?;
                }
            }
            delay = (delay + Duration::from_millis(100)).min(Duration::from_millis(750));
        }
    }
    fn write_watch(&mut self, wanted: bool) -> Result<()> {
        if self.write_watched != wanted {
            if let Some(ws) = &self.ws {
                self.poll.change(
                    ws.get_ref().as_raw_fd() as usize,
                    libc::EVFILT_WRITE,
                    if wanted {
                        libc::EV_ADD | libc::EV_CLEAR
                    } else {
                        libc::EV_DELETE
                    },
                    0,
                )?;
            }
            self.write_watched = wanted;
        }
        Ok(())
    }
    fn send(
        &mut self,
        method: &str,
        params: Value,
        session: Option<String>,
        kind: Kind,
    ) -> Result<()> {
        if self.ws.is_none() {
            return Err(error("CDP 未连接"));
        }
        self.next_id += 1;
        let id = self.next_id;
        let mut request = json!({"id":id,"method":method,"params":params});
        if let Some(session) = session {
            request["sessionId"] = session.into();
        }
        self.requests.insert(
            id,
            Request {
                kind,
                until: Instant::now() + Duration::from_secs(if self.stopping { 2 } else { 8 }),
            },
        );
        let result = self
            .ws
            .as_mut()
            .unwrap()
            .send(Message::Text(serde_json::to_string(&request)?.into()));
        match result {
            Ok(()) => Ok(()),
            Err(WsError::Io(e)) if e.kind() == io::ErrorKind::WouldBlock => self.write_watch(true),
            Err(e) => Err(e.into()),
        }
    }
    fn session(&self, key: &str) -> Option<String> {
        self.renderers.get(key).and_then(|r| r.session.clone())
    }
    fn add_renderer(&mut self, key: String, session: Option<String>) -> Result<()> {
        self.renderers.insert(
            key.clone(),
            Renderer {
                session: session.clone(),
                ..Default::default()
            },
        );
        self.report()?;
        // Ordered WebSocket messages enable Runtime before the debugger.
        self.send(
            "Runtime.enable",
            json!({}),
            session.clone(),
            Kind::Scoped(key.clone(), 0),
        )?;
        self.send("Debugger.enable", json!({}), session, Kind::Scoped(key, 0))
    }
    fn attach(&mut self, key: String) -> Result<()> {
        if !self.targets.contains(&key)
            || self.renderers.contains_key(&key)
            || !self.attaching.insert(key.clone())
        {
            return Ok(());
        }
        self.report()?;
        self.send(
            "Target.attachToTarget",
            json!({"targetId":key,"flatten":true}),
            None,
            Kind::Attach(key),
        )
    }
    fn event(&mut self, message: &Value) -> Result<()> {
        if self.stopping {
            return Ok(());
        }
        let method = strv(message, "method");
        let p = &message["params"];
        let key = if self.direct {
            Some("probe".to_string())
        } else if let Some(sid) = message.get("sessionId").and_then(Value::as_str) {
            self.renderers
                .iter()
                .find(|(_, r)| r.session.as_deref() == Some(sid))
                .map(|(k, _)| k.clone())
        } else {
            None
        };
        if let Some(key) = key {
            if method == "Runtime.executionContextsCleared" {
                let Some(r) = self.renderers.get_mut(&key) else {
                    return Ok(());
                };
                r.generation += 1;
                r.scripts.clear();
                r.ready = false;
                let bp = r.breakpoint.take();
                let sid = r.session.clone();
                if let Some(bp) = bp {
                    self.send(
                        "Debugger.removeBreakpoint",
                        json!({"breakpointId":bp}),
                        sid,
                        Kind::Ignore,
                    )?;
                }
                return self.report();
            }
            if method == "Debugger.scriptParsed" && strv(p, "url") == strv(&self.manifest, "url") {
                let script = strv(p, "scriptId");
                if script.is_empty() {
                    return Err(error("脚本 ID 无效"));
                }
                let Some(r) = self.renderers.get_mut(&key) else {
                    return Ok(());
                };
                if !r.scripts.insert(script.into()) {
                    return Ok(());
                }
                if r.scripts.len() != 1 {
                    return Err(error("同一窗口多个额度脚本实例，停止解锁"));
                }
                let generation = r.generation;
                let sid = r.session.clone();
                return self.send(
                    "Debugger.getScriptSource",
                    json!({"scriptId":script}),
                    sid,
                    Kind::Source(key, generation),
                );
            }
            return Ok(());
        }
        if matches!(method, "Target.targetCreated" | "Target.targetInfoChanged") {
            let info = &p["targetInfo"];
            let url = strv(info, "url");
            let target_url = url.split('?').next().unwrap_or("");
            let avatar_overlay = url
                .split('?')
                .nth(1)
                .unwrap_or("")
                .split('&')
                .any(|parameter| {
                    matches!(
                        parameter,
                        "initialRoute=%2Favatar-overlay"
                            | "initialRoute=%2favatar-overlay"
                            | "initialRoute=/avatar-overlay"
                    )
                });
            if strv(info, "type") == "page" && target_url == "app://-/index.html" && !avatar_overlay
            {
                let id = strv(info, "targetId").to_string();
                self.targets.insert(id.clone());
                self.attach(id)?;
            }
        } else if method == "Target.targetDestroyed" {
            let id = strv(p, "targetId");
            self.targets.remove(id);
            self.renderers.remove(id);
            self.attaching.remove(id);
            self.retry.remove(id);
            self.report()?;
        } else if method == "Target.detachedFromTarget" {
            let sid = strv(p, "sessionId");
            if let Some(key) = self
                .renderers
                .iter()
                .find(|(_, r)| r.session.as_deref() == Some(sid))
                .map(|(k, _)| k.clone())
            {
                self.renderers.remove(&key);
                if self.targets.contains(&key) {
                    self.retry
                        .insert(key, Instant::now() + Duration::from_millis(500));
                }
                self.report()?;
            }
        }
        Ok(())
    }
    fn response(&mut self, message: &Value) -> Result<()> {
        let Some(id) = message["id"].as_u64() else {
            return self.event(message);
        };
        let Some(request) = self.requests.remove(&id) else {
            return Ok(());
        };
        if self.stopping {
            return Ok(());
        }
        match &request.kind {
            Kind::Ignore => return Ok(()),
            Kind::Attach(key) if !self.targets.contains(key) => {
                self.attaching.remove(key);
                return self.report();
            }
            Kind::Scoped(key, generation)
            | Kind::Source(key, generation)
            | Kind::Positions(key, generation, _)
            | Kind::Refreshed(key, generation)
                if !self
                    .renderers
                    .get(key)
                    .is_some_and(|r| r.generation == *generation) =>
            {
                return Ok(())
            }
            Kind::Mounted(key, _) if !self.renderers.contains_key(key) => return Ok(()),
            _ => {}
        }
        if let Some(e) = message.get("error") {
            return Err(error(format!("CDP 命令失败：{}", strv(e, "message"))));
        }
        let data = &message["result"];
        match request.kind {
            Kind::Attach(key) => {
                self.attaching.remove(&key);
                if !self.targets.contains(&key) {
                    return Ok(());
                }
                let sid = strv(data, "sessionId");
                if sid.is_empty() {
                    return Err(error("缺少调试会话"));
                }
                self.add_renderer(key, Some(sid.into()))?;
            }
            Kind::Source(key, generation) => {
                if !self
                    .renderers
                    .get(&key)
                    .is_some_and(|r| r.generation == generation)
                {
                    return Ok(());
                }
                let source = data["scriptSource"]
                    .as_str()
                    .ok_or_else(|| error("缺少脚本源码"))?;
                let hash = format!("{:x}", Sha256::digest(source.as_bytes()));
                if hash != strv(&self.manifest, "bundleSha256") {
                    return Err(error("运行中前端哈希不一致，停止解锁"));
                }
                let script = self.renderers[&key].scripts.iter().next().unwrap().clone();
                let l = &self.manifest["location"];
                let start = json!({"scriptId":script,"lineNumber":l["lineNumber"],"columnNumber":l["columnNumber"]});
                let end = json!({"scriptId":script,"lineNumber":l.get("endLineNumber").unwrap_or(&l["lineNumber"]),"columnNumber":l["endColumnNumber"].as_u64().unwrap_or(l["columnNumber"].as_u64().unwrap()+300)});
                self.send(
                    "Debugger.getPossibleBreakpoints",
                    json!({"start":start,"end":end,"restrictToFunction":true}),
                    self.session(&key),
                    Kind::Positions(key, generation, script),
                )?;
            }
            Kind::Positions(key, generation, script) => {
                if !self
                    .renderers
                    .get(&key)
                    .is_some_and(|r| r.generation == generation)
                {
                    return Ok(());
                }
                let loc = &self.manifest["location"];
                let line = loc["lineNumber"].as_u64().unwrap();
                let column = loc["columnNumber"].as_u64().unwrap();
                let el = loc["endLineNumber"].as_u64().unwrap_or(line);
                let ec = loc["endColumnNumber"].as_u64().unwrap_or(column + 300);
                let mut possible: Vec<&Value> = data["locations"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|v| {
                        if strv(v, "scriptId") != script {
                            return false;
                        }
                        match (v["lineNumber"].as_u64(), v["columnNumber"].as_u64()) {
                            (Some(l), Some(c)) => {
                                (l > line || l == line && c >= column)
                                    && (l < el || l == el && c < ec)
                            }
                            _ => false,
                        }
                    })
                    .collect();
                possible.sort_by_key(|v| (v["lineNumber"].as_u64(), v["columnNumber"].as_u64()));
                let actual = possible
                    .first()
                    .ok_or_else(|| error("额度表达式内没有可执行断点，需要适配"))?;
                self.send(
                    "Debugger.setBreakpoint",
                    json!({"location":actual,"condition":self.manifest["condition"]}),
                    self.session(&key),
                    Kind::Mounted(key, generation),
                )?;
            }
            Kind::Mounted(key, generation) => {
                let bp = strv(data, "breakpointId").to_string();
                if bp.is_empty() || data.get("actualLocation").is_none() {
                    return Err(error("断点未挂载"));
                }
                if let Some(r) = self.renderers.get_mut(&key) {
                    if r.generation == generation {
                        r.breakpoint = Some(bp);
                        if let Some(expression) = composer_refresh(&self.manifest) {
                            self.send(
                                "Runtime.evaluate",
                                json!({"expression":expression,"awaitPromise":true,"returnByValue":true}),
                                self.session(&key),
                                Kind::Refreshed(key, generation),
                            )?;
                        } else {
                            r.ready = true;
                            self.report()?;
                        }
                    } else {
                        self.send(
                            "Debugger.removeBreakpoint",
                            json!({"breakpointId":bp}),
                            self.session(&key),
                            Kind::Ignore,
                        )?;
                    }
                }
            }
            Kind::Refreshed(key, _) => {
                if data.get("exceptionDetails").is_some() {
                    return Err(error("本地编辑器缓存刷新失败，需要适配"));
                }
                if let Some(renderer) = self.renderers.get_mut(&key) {
                    renderer.ready = true;
                    self.report()?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    fn flush(&mut self) -> Result<()> {
        if let Some(ws) = &mut self.ws {
            match ws.flush() {
                Ok(()) => self.write_watch(false)?,
                Err(WsError::Io(e)) if e.kind() == io::ErrorKind::WouldBlock => {
                    self.write_watch(true)?
                }
                Err(e) => return Err(e.into()),
            }
        }
        Ok(())
    }
    fn drain(&mut self) -> Result<()> {
        loop {
            let result = self.ws.as_mut().ok_or_else(|| error("CDP 已关闭"))?.read();
            match result {
                Ok(Message::Text(text)) => {
                    let v: Value = serde_json::from_str(&text)?;
                    self.response(&v)?;
                }
                Ok(Message::Binary(data)) => {
                    let v: Value = serde_json::from_slice(&data)?;
                    self.response(&v)?;
                }
                Ok(Message::Close(_)) => return Err(error("调试连接关闭")),
                Ok(_) => {}
                Err(WsError::Io(e)) if e.kind() == io::ErrorKind::WouldBlock => break,
                Err(e) => return Err(e.into()),
            }
        }
        self.flush()
    }
    fn begin_stop(&mut self, failure: Option<String>) -> Result<()> {
        if self.stopping {
            return Ok(());
        }
        self.stopping = true;
        self.failure = failure;
        self.requests.clear();
        self.retry.clear();
        self.startup_until = None;
        self.stop_until = Some(Instant::now() + Duration::from_millis(2500));
        if self.ws.is_none() {
            return Ok(());
        }
        let items: Vec<_> = self
            .renderers
            .values()
            .map(|r| (r.session.clone(), r.breakpoint.clone()))
            .collect();
        for (sid, bp) in items {
            if let Some(bp) = bp {
                let _ = self.send(
                    "Debugger.removeBreakpoint",
                    json!({"breakpointId":bp}),
                    sid.clone(),
                    Kind::Cleanup,
                );
                if let Some(expression) = composer_refresh(&self.manifest) {
                    let _ = self.send(
                        "Runtime.evaluate",
                        json!({"expression":expression,"awaitPromise":true,"returnByValue":true}),
                        sid.clone(),
                        Kind::Cleanup,
                    );
                }
            }
            let _ = self.send("Debugger.disable", json!({}), sid, Kind::Cleanup);
        }
        Ok(())
    }
    fn finish(&mut self) -> Result<()> {
        let state = if self.failure.is_some() {
            "failed"
        } else {
            "stopped"
        };
        self.update(state)?;
        if let Some(ws) = &mut self.ws {
            let _ = ws.close(None);
            let _ = ws.flush();
        }
        self.ws = None;
        Ok(())
    }
    fn run(&mut self) -> Result<()> {
        loop {
            if self.stopping {
                let now = Instant::now();
                self.requests.retain(|_, r| r.until > now);
            }
            if self.stopping
                && (self.requests.is_empty()
                    || self.stop_until.is_some_and(|t| Instant::now() >= t))
            {
                break;
            }
            let until = self
                .requests
                .values()
                .map(|r| r.until)
                .chain(self.retry.values().copied())
                .chain(self.startup_until)
                .chain(self.stop_until)
                .min();
            for event in self.poll.wait(until)? {
                if event.filter == libc::EVFILT_PROC {
                    self.ws = None;
                    self.requests.clear();
                    self.failure = None;
                    self.begin_stop(None)?;
                    continue;
                }
                if event.filter == libc::EVFILT_SIGNAL {
                    self.begin_stop(None)?;
                    continue;
                }
                if event.filter == libc::EVFILT_READ
                    && event.ident == self.server.listener.as_raw_fd() as usize
                {
                    self.serve()?;
                    continue;
                }
                if self.ws.is_some() {
                    let outcome = if event.filter == libc::EVFILT_WRITE {
                        self.flush()
                    } else {
                        self.drain()
                    };
                    if let Err(e) = outcome {
                        let normal = self.watch_pid.is_some_and(|pid| proc_path(pid).is_none());
                        self.begin_stop(if normal { None } else { Some(e.to_string()) })?;
                    }
                }
            }
            let now = Instant::now();
            if !self.stopping {
                if self.startup_until.is_some_and(|t| now >= t) {
                    self.begin_stop(Some("未找到兼容调试窗口，启动超时".into()))?;
                } else if self.requests.values().any(|r| now >= r.until) {
                    self.begin_stop(Some("CDP 命令超时".into()))?;
                } else {
                    let due: Vec<_> = self
                        .retry
                        .iter()
                        .filter(|(_, t)| now >= **t)
                        .map(|(k, _)| k.clone())
                        .collect();
                    for key in due {
                        self.retry.remove(&key);
                        self.attach(key)?;
                    }
                }
            }
        }
        self.finish()?;
        if let Some(failure) = &self.failure {
            return Err(error(failure.clone()));
        }
        Ok(())
    }
}
fn bootstrap_exe() -> Result<PathBuf> {
    if let Some(path) = env::var_os("CODEX_UNLOCK_BOOTSTRAP") {
        return Ok(path.into());
    }
    let exe = env::current_exe()?;
    let helper = exe.parent().unwrap().join("CodexUnlockBootstrap");
    if helper.exists() {
        Ok(helper)
    } else {
        Err(error("缺少短暂运行的 Swift 启动辅助程序"))
    }
}
fn execute() -> Result<()> {
    let args: Vec<String> = env::args().skip(1).collect();
    let action = args.first().map(String::as_str).unwrap_or("help");
    let value = |key: &str| {
        args.iter()
            .position(|s| s == key)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let dir = value("--data-dir").map(PathBuf::from).unwrap_or_else(|| {
        PathBuf::from(env::var_os("HOME").unwrap_or_default())
            .join("Library/Application Support/Codex Input Unlock")
    });
    match action {
        "status"=>println!("{}",status(&dir)?),"stop"=>println!("{}",stop(&dir)?),
        "clean"=>{if verify_dir(&dir,false)?{stop(&dir)?;let _lock=lock(&dir,"agent.lock")?;let _launch=lock(&dir,"launch.lock")?;fs::remove_dir_all(&dir)?;}println!("{}",json!({"state":"clean"}));},
        "probe"|"agent"=>{
            if action=="probe"&&value("--data-dir").is_none(){return Err(error("隔离验证必须显式指定 --data-dir"));}
            let manifest=read_json(&PathBuf::from(value("--manifest").ok_or_else(||error("缺少 --manifest"))?))?;
            let mut agent=Agent::new(dir,manifest,action=="probe"&&!args.iter().any(|s|s=="--browser"))?;
            unsafe{libc::setsid();}agent.update("waiting")?;
            let outcome=if action=="probe"{
                if let Some(pid)=value("--watch-pid"){agent.watch(pid.parse()?)?;}
                agent.start_ws(&value("--ws").ok_or_else(||error("缺少 --ws"))?)
            }else{agent.bootstrap()};
            if let Err(e)=outcome{agent.begin_stop(Some(e.to_string()))?;}
            agent.run()?;
        },
        "locate"|"inspect"|"diagnose"|"start"=>{let status=Command::new(bootstrap_exe()?).args(&args).status()?;if !status.success(){return Err(error("Swift 启动辅助命令未完成"));}},
        _=>println!("Codex Input Unlock：probe|agent|status|stop|clean；启动与静态定位由 Swift 短暂辅助完成，常驻进程不加载 Swift 或 Foundation")
    }
    Ok(())
}
fn main() -> ExitCode {
    match execute() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}
