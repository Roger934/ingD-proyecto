-- MySQL 8.4 — base ecommerce: clientes y pedidos.
-- Fragmentación VERTICAL (D7): la entidad lógica Pedido está partida en dos tablas
-- con la MISMA llave primaria:
--   pedidos         → datos operativos (quién, cuándo, cuánto, estado)
--   pedido_cliente  → datos de entrega y contacto
-- La vista pedido_completo la reconstruye con un JOIN por esa llave.
-- Lo aplica scripts/mysql/esquema.sh en db1; la réplica (db2) lo recibe por replicación.

CREATE TABLE IF NOT EXISTS clientes (
  id          INT           NOT NULL,
  nombre      VARCHAR(120)  NOT NULL,
  email       VARCHAR(160)  NOT NULL,
  telefono    VARCHAR(20)   NOT NULL,
  fecha_alta  DATETIME      NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_clientes_email (email)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS direcciones (
  id          INT           NOT NULL AUTO_INCREMENT,
  cliente_id  INT           NOT NULL,
  calle       VARCHAR(160)  NOT NULL,
  ciudad      VARCHAR(80)   NOT NULL,
  estado      VARCHAR(60)   NOT NULL,
  cp          CHAR(5)       NOT NULL,
  principal   TINYINT(1)    NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY ix_direcciones_cliente (cliente_id),
  CONSTRAINT fk_direcciones_cliente FOREIGN KEY (cliente_id) REFERENCES clientes (id)
) ENGINE=InnoDB;

-- Fragmento 1 del Pedido: datos operativos.
-- sucursal_id es una referencia lógica a PostgreSQL (las bases no se conectan entre sí).
CREATE TABLE IF NOT EXISTS pedidos (
  id                  BIGINT         NOT NULL AUTO_INCREMENT,
  cliente_id          INT            NOT NULL,
  sucursal_id         SMALLINT       NOT NULL,
  fecha               DATETIME       NOT NULL,
  total               DECIMAL(12,2)  NOT NULL,
  estado              ENUM('PENDIENTE','CONFIRMADO','CANCELADO') NOT NULL DEFAULT 'PENDIENTE',
  clave_idempotencia  CHAR(36)       NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_pedidos_clave (clave_idempotencia),
  KEY ix_pedidos_cliente (cliente_id),
  KEY ix_pedidos_estado_fecha (estado, fecha),
  CONSTRAINT fk_pedidos_cliente FOREIGN KEY (cliente_id) REFERENCES clientes (id)
) ENGINE=InnoDB;

-- Fragmento 2 del Pedido: entrega y contacto. Misma PK que pedidos.
-- Guarda una copia de la dirección: es la del momento de la compra, aunque el cliente la cambie después.
CREATE TABLE IF NOT EXISTS pedido_cliente (
  pedido_id          BIGINT        NOT NULL,
  direccion_id       INT           NOT NULL,
  destinatario       VARCHAR(120)  NOT NULL,
  telefono_contacto  VARCHAR(20)   NOT NULL,
  calle              VARCHAR(160)  NOT NULL,
  ciudad             VARCHAR(80)   NOT NULL,
  estado             VARCHAR(60)   NOT NULL,
  cp                 CHAR(5)       NOT NULL,
  instrucciones      VARCHAR(200)  NULL,
  PRIMARY KEY (pedido_id),
  CONSTRAINT fk_pedido_cliente_pedido    FOREIGN KEY (pedido_id)    REFERENCES pedidos (id) ON DELETE CASCADE,
  CONSTRAINT fk_pedido_cliente_direccion FOREIGN KEY (direccion_id) REFERENCES direcciones (id)
) ENGINE=InnoDB;

-- producto_id es una referencia lógica al catálogo de MongoDB y a PostgreSQL.
CREATE TABLE IF NOT EXISTS detalle_pedido (
  id               BIGINT         NOT NULL AUTO_INCREMENT,
  pedido_id        BIGINT         NOT NULL,
  producto_id      INT            NOT NULL,
  cantidad         INT            NOT NULL,
  precio_unitario  DECIMAL(10,2)  NOT NULL,
  PRIMARY KEY (id),
  KEY ix_detalle_pedido (pedido_id),
  KEY ix_detalle_producto (producto_id),
  CONSTRAINT fk_detalle_pedido FOREIGN KEY (pedido_id) REFERENCES pedidos (id) ON DELETE CASCADE,
  CONSTRAINT ck_detalle_cantidad CHECK (cantidad > 0)
) ENGINE=InnoDB;

-- Reconstrucción de la entidad Pedido (demo: "JOIN que reconstruye el Pedido").
-- SQL SECURITY INVOKER: la vista no depende del usuario que la creó (también existe igual en la réplica).
CREATE OR REPLACE SQL SECURITY INVOKER VIEW pedido_completo AS
SELECT p.id, p.cliente_id, p.sucursal_id, p.fecha, p.total, p.estado,
       pc.direccion_id, pc.destinatario, pc.telefono_contacto,
       pc.calle, pc.ciudad, pc.estado AS estado_entrega, pc.cp, pc.instrucciones
FROM pedidos p
JOIN pedido_cliente pc ON pc.pedido_id = p.id;
