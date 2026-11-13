<?php
// GET → the signed-in user's positions + settings. PUT {positions, settings} → save them.
require __DIR__ . '/_bootstrap.php';
guard();
start_session();
$u = current_user();
if (!$u) fail(401, 'Not signed in');
session_write_close(); // don't hold the session lock

$db = db();
if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $st = $db->prepare('SELECT positions, settings, updated FROM userdata WHERE user_id = ?');
    $st->execute([$u['id']]);
    $r = $st->fetch() ?: ['positions' => '[]', 'settings' => '{}', 'updated' => 0];
    out(['ok' => true, 'positions' => json_decode($r['positions'] ?: '[]', true) ?: [],
        'settings' => json_decode($r['settings'] ?: '{}', true) ?: new stdClass(), 'updated' => (int) $r['updated']]);
}

if ($_SERVER['REQUEST_METHOD'] === 'PUT' || $_SERVER['REQUEST_METHOD'] === 'POST') {
    $b = body();
    if (!isset($b['positions']) || !is_array($b['positions']) || !array_is_list($b['positions'])) fail(400, 'positions must be a list');
    if (count($b['positions']) > 5000) fail(413, 'Too many positions');
    $settings = isset($b['settings']) && is_array($b['settings']) ? $b['settings'] : [];
    $now = (int) round(microtime(true) * 1000);
    $pos = json_encode($b['positions'], JSON_UNESCAPED_SLASHES);
    $set = json_encode((object) $settings, JSON_UNESCAPED_SLASHES);
    $st = $db->prepare('UPDATE userdata SET positions = ?, settings = ?, updated = ? WHERE user_id = ?');
    $st->execute([$pos, $set, $now, $u['id']]);
    if ($st->rowCount() === 0) {
        $db->prepare('INSERT INTO userdata (user_id, positions, settings, updated) VALUES (?, ?, ?, ?)')->execute([$u['id'], $pos, $set, $now]);
    }
    out(['ok' => true, 'updated' => $now]);
}
fail(405, 'Method not allowed');
