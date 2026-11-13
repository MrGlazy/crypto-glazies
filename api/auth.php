<?php
// POST {action: signup|login|logout}, GET → current user
require __DIR__ . '/_bootstrap.php';
guard();
start_session();

$pub = fn(array $u) => ['id' => (int) $u['id'], 'email' => $u['email'], 'name' => $u['name'], 'created' => (int) $u['created']];

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $u = current_user();
    out(['ok' => true, 'user' => $u ? $pub($u) : null]);
}

$b = body();
$action = $b['action'] ?? '';

if ($action === 'logout') {
    $_SESSION = [];
    session_destroy();
    out(['ok' => true]);
}

$email = strtolower(trim((string) ($b['email'] ?? '')));
$pass = (string) ($b['password'] ?? '');
if (!filter_var($email, FILTER_VALIDATE_EMAIL) || strlen($email) > 190) fail(400, 'Enter a valid email address');
if (strlen($pass) < 8 || strlen($pass) > 200) fail(400, 'Password must be at least 8 characters');

rate_limit();
$db = db();

if ($action === 'signup') {
    $name = trim(preg_replace('/\s+/', ' ', (string) ($b['name'] ?? '')));
    if ($name === '') $name = explode('@', $email)[0];
    $name = mb_substr($name, 0, 60);
    $st = $db->prepare('SELECT 1 FROM users WHERE email = ?');
    $st->execute([$email]);
    if ($st->fetchColumn()) { record_attempt(); fail(409, 'An account with that email already exists — log in instead'); }
    $db->prepare('INSERT INTO users (email, name, pass, created) VALUES (?, ?, ?, ?)')
        ->execute([$email, $name, password_hash($pass, PASSWORD_DEFAULT), time()]);
    $id = (int) $db->lastInsertId();
    $db->prepare('INSERT INTO userdata (user_id, positions, settings, updated) VALUES (?, ?, ?, ?)')
        ->execute([$id, '[]', '{}', 0]);
    record_attempt(); // counts toward the limit to slow down mass sign-ups
    session_regenerate_id(true);
    $_SESSION['uid'] = $id;
    out(['ok' => true, 'user' => $pub(current_user())]);
}

if ($action === 'login') {
    $st = $db->prepare('SELECT * FROM users WHERE email = ?');
    $st->execute([$email]);
    $u = $st->fetch();
    if (!$u || !password_verify($pass, $u['pass'])) { record_attempt(); fail(401, 'Wrong email or password'); }
    if (password_needs_rehash($u['pass'], PASSWORD_DEFAULT)) {
        $db->prepare('UPDATE users SET pass = ? WHERE id = ?')->execute([password_hash($pass, PASSWORD_DEFAULT), $u['id']]);
    }
    session_regenerate_id(true);
    $_SESSION['uid'] = (int) $u['id'];
    out(['ok' => true, 'user' => $pub($u)]);
}

fail(400, 'Unknown action');
