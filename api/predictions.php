<?php
// AI predictions computed on the NAS (see /nas).
// GET  → latest uploaded predictions + pause state (public); `admin` tells the page whether to show Pause/Resume.
// POST with "Authorization: Bearer <token>" → the NAS uploads new predictions.
// POST {action: "pause" | "resume"} from a signed-in admin → pauses / resumes the NAS.
// Only the SHA-256 of the upload token is stored here, so the repo can stay public.
require __DIR__ . '/_bootstrap.php';
guard();

const TOKEN_SHA256 = '61225cdcfed805c8272f50dd2e1004e9f6a673a5198c33449b1a396db786feed';
const ADMIN_IDS = [1]; // site accounts allowed to pause / resume the NAS

$file = data_dir() . '/predictions.json';
$ctlFile = data_dir() . '/ai-control.json';

function control(string $f): array {
    $c = is_file($f) ? json_decode((string) file_get_contents($f), true) : null;
    return is_array($c) ? $c + ['paused' => false] : ['paused' => false, 'at' => null];
}
function is_admin(): bool {
    if (empty($_COOKIE['gzsid'])) return false; // no session → skip the session machinery (e.g. the NAS)
    start_session();
    $u = current_user();
    session_write_close();
    return $u !== null && in_array((int) $u['id'], ADMIN_IDS, true);
}

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $raw = is_file($file) ? file_get_contents($file) : false;
    $meta = json_encode(['control' => control($ctlFile), 'admin' => is_admin()], JSON_UNESCAPED_SLASHES);
    header('Content-Type: application/json; charset=utf-8');
    echo '{"ok":true,"data":' . ($raw === false ? 'null' : $raw) . ',' . substr($meta, 1);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $auth = (string) ($_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '');
    $token = str_starts_with($auth, 'Bearer ') ? substr($auth, 7) : (string) ($_SERVER['HTTP_X_UPLOAD_TOKEN'] ?? '');
    $b = body();

    if ($token === '') {
        // Pause / resume from the website
        $action = $b['action'] ?? '';
        if (!in_array($action, ['pause', 'resume'], true)) fail(400, 'Unknown action');
        if (!is_admin()) fail(403, 'Only the site owner can do this');
        $c = ['paused' => $action === 'pause', 'at' => (int) round(microtime(true) * 1000)];
        if (file_put_contents($ctlFile, json_encode($c)) === false) fail(500, 'Could not save');
        out(['ok' => true, 'control' => $c]);
    }

    $want = (string) (cfg()['predict_token_sha256'] ?? TOKEN_SHA256);
    if (!hash_equals($want, hash('sha256', $token))) fail(401, 'Bad upload token');
    if (($b['version'] ?? null) !== 1 || !isset($b['horizons']) || !is_array($b['horizons'])) fail(400, 'Unexpected payload');
    $b['received'] = (int) round(microtime(true) * 1000);
    $tmp = $file . '.tmp';
    if (file_put_contents($tmp, json_encode($b, JSON_UNESCAPED_SLASHES)) === false || !rename($tmp, $file)) fail(500, 'Could not save');
    out(['ok' => true, 'received' => $b['received'], 'control' => control($ctlFile)]);
}
fail(405, 'Method not allowed');
