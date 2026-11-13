<?php
// Shared setup for the account API: database, sessions, JSON helpers.
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');

function out(array $data, int $code = 200): never {
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_SLASHES);
    exit;
}
function fail(int $code, string $msg): never { out(['ok' => false, 'error' => $msg], $code); }

function cfg(): array {
    static $c = null;
    if ($c !== null) return $c;
    $c = ['dsn' => null, 'user' => null, 'pass' => null, 'data_dir' => null];
    $local = __DIR__ . '/config.local.php'; // optional, not in git (e.g. to use MySQL)
    if (is_file($local)) $c = array_merge($c, (array) require $local);
    return $c;
}

/** Private, writable folder OUTSIDE the deployed site so git deploys never touch it. */
function data_dir(): string {
    static $dir = null;
    if ($dir !== null) return $dir;
    $site = dirname(__DIR__);
    $cands = array_filter([cfg()['data_dir'], dirname($site, 2) . '/glazies-crypto-data', $site . '/data']);
    foreach ($cands as $d) {
        if (!is_dir($d)) @mkdir($d, 0700, true);
        if (is_dir($d) && is_writable($d)) {
            if (str_starts_with(realpath($d), realpath($site))) {
                @file_put_contents("$d/.htaccess", "Require all denied\nDeny from all\n");
            }
            return $dir = $d;
        }
    }
    fail(500, 'Server storage is not writable');
}

function db(): PDO {
    static $pdo = null;
    if ($pdo) return $pdo;
    $c = cfg();
    $dsn = $c['dsn'] ?: 'sqlite:' . data_dir() . '/app.sqlite';
    $pdo = new PDO($dsn, $c['user'], $c['pass'], [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
    $mysql = $pdo->getAttribute(PDO::ATTR_DRIVER_NAME) === 'mysql';
    if (!$mysql) $pdo->exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    $id = $mysql ? 'INT AUTO_INCREMENT PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
    $text = $mysql ? 'LONGTEXT' : 'TEXT';
    $pdo->exec("CREATE TABLE IF NOT EXISTS users (
        id $id, email VARCHAR(190) NOT NULL UNIQUE, name VARCHAR(60) NOT NULL,
        pass VARCHAR(255) NOT NULL, created BIGINT NOT NULL)");
    $pdo->exec("CREATE TABLE IF NOT EXISTS userdata (
        user_id INT PRIMARY KEY, positions $text, settings $text, updated BIGINT NOT NULL)");
    $pdo->exec("CREATE TABLE IF NOT EXISTS attempts (ip VARCHAR(64) NOT NULL, ts BIGINT NOT NULL)");
    return $pdo;
}

function start_session(): void {
    $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
    $life = 60 * 60 * 24 * 30;
    $path = data_dir() . '/sessions';
    if (!is_dir($path)) @mkdir($path, 0700, true);
    session_save_path($path);
    ini_set('session.gc_maxlifetime', (string) $life);
    ini_set('session.use_strict_mode', '1');
    session_name('gzsid');
    session_set_cookie_params(['lifetime' => $life, 'path' => '/', 'secure' => $https, 'httponly' => true, 'samesite' => 'Lax']);
    session_start();
}

/** Every request must be same-origin JSON with our header (blocks cross-site form posts). */
function guard(): void {
    if ($_SERVER['REQUEST_METHOD'] !== 'GET' && ($_SERVER['HTTP_X_GLAZIES'] ?? '') !== '1') fail(403, 'Bad request');
}

function body(): array {
    $raw = file_get_contents('php://input', false, null, 0, 2_000_001);
    if (strlen((string) $raw) > 2_000_000) fail(413, 'Too much data');
    $j = json_decode((string) $raw, true);
    return is_array($j) ? $j : [];
}

function current_user(): ?array {
    $uid = $_SESSION['uid'] ?? null;
    if (!$uid) return null;
    $st = db()->prepare('SELECT id, email, name, created FROM users WHERE id = ?');
    $st->execute([$uid]);
    return $st->fetch() ?: null;
}

function client_ip(): string { return substr((string) ($_SERVER['REMOTE_ADDR'] ?? '?'), 0, 64); }

function rate_limit(): void {
    $db = db();
    $since = time() - 900;
    $db->prepare('DELETE FROM attempts WHERE ts < ?')->execute([$since]);
    $st = $db->prepare('SELECT COUNT(*) FROM attempts WHERE ip = ? AND ts >= ?');
    $st->execute([client_ip(), $since]);
    if ((int) $st->fetchColumn() >= 15) fail(429, 'Too many attempts — try again in 15 minutes');
}
function record_attempt(): void {
    db()->prepare('INSERT INTO attempts (ip, ts) VALUES (?, ?)')->execute([client_ip(), time()]);
}
