<?php
// AI predictions computed on the NAS (see /nas).
// GET  → latest uploaded predictions (public).
// POST → upload new predictions; needs "Authorization: Bearer <token>".
// Only the SHA-256 of the token is stored here, so the repo can stay public.
require __DIR__ . '/_bootstrap.php';
guard();

const TOKEN_SHA256 = '61225cdcfed805c8272f50dd2e1004e9f6a673a5198c33449b1a396db786feed';

$file = data_dir() . '/predictions.json';

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $raw = is_file($file) ? file_get_contents($file) : false;
    if ($raw === false) out(['ok' => true, 'data' => null]);
    header('Content-Type: application/json; charset=utf-8');
    echo '{"ok":true,"data":' . $raw . '}';
    exit;
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $auth = (string) ($_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '');
    $token = str_starts_with($auth, 'Bearer ') ? substr($auth, 7) : (string) ($_SERVER['HTTP_X_UPLOAD_TOKEN'] ?? '');
    $want = (string) (cfg()['predict_token_sha256'] ?? TOKEN_SHA256);
    if ($token === '' || !hash_equals($want, hash('sha256', $token))) fail(401, 'Bad upload token');

    $b = body();
    if (($b['version'] ?? null) !== 1 || !isset($b['horizons']) || !is_array($b['horizons'])) fail(400, 'Unexpected payload');
    $b['received'] = (int) round(microtime(true) * 1000);
    $tmp = $file . '.tmp';
    if (file_put_contents($tmp, json_encode($b, JSON_UNESCAPED_SLASHES)) === false || !rename($tmp, $file)) fail(500, 'Could not save');
    out(['ok' => true, 'received' => $b['received']]);
}
fail(405, 'Method not allowed');
