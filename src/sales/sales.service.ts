/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Order } from './schemas/order.schema';
import { Product } from '../products/schemas/product.schema';
import { User } from '../users/schemas/user.schema';
import type { AdminOrdersQueryDto } from './dto/admin-orders.dto';
import { Promotion } from 'src/promotions/schemas/promotion.schema';
import { NotificationGateway } from '../notifications/notification.gateway';
import { ProductItem } from 'src/products/schemas/product-item.schema';
import { NotificationsService } from 'src/users/notifications.service';

@Injectable()
export class SalesService {
  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<Order>,
    @InjectModel(Product.name) private readonly productModel: Model<Product>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(Promotion.name) private readonly promotionModel: Model<Promotion>,
    private readonly notificationGateway: NotificationGateway,
    @InjectModel(ProductItem.name) private readonly productItemModel: Model<ProductItem>,
    private readonly notificationsService: NotificationsService,
  ) {}

  private makeOrderCode(): string {
    const y = new Date().getFullYear();
    const n = Math.floor(1000 + Math.random() * 9000);
    return `NT-${y}-${n}`;
  }

  /** Ảnh path tương đối (/uploads/...) cần origin BE để Next (port 3000) hiển thị đúng */
  private absolutizeAssetUrl(url: string): string {
    const u = (url || '').trim();
    if (!u) return '';
    if (/^https?:\/\//i.test(u)) return u;
    const base = (process.env.PUBLIC_API_URL || '').replace(/\/$/, '');
    const path = u.startsWith('/') ? u : `/${u}`;
    return base ? `${base}${path}` : path;
  }

  private specSummary(
    specifications: Record<string, unknown> | null | undefined,
  ): string {
    if (!specifications || typeof specifications !== 'object') return '—';
    const s = specifications as Record<string, unknown>;
    const cpu =
      s.cpu != null
        ? String(s.cpu)
        : s.processor != null
          ? String(s.processor)
          : '';
    const ram = s.ram != null ? String(s.ram) : '';
    const storage = s.storage != null ? String(s.storage) : '';
    const gpu = s.gpu != null ? String(s.gpu) : '';
    const parts = [cpu, ram || storage, storage].filter(Boolean);
    if (parts.length) return [...new Set(parts)].slice(0, 4).join(' / ');
    const vals = Object.values(s)
      .filter((v) => v != null && typeof v !== 'object')
      .slice(0, 3)
      .map(String);
    return vals.length ? vals.join(' / ') : '—';
  }

  async checkout(userId: string, checkoutData: any) {
    if (!userId || !Types.ObjectId.isValid(userId)) {
      throw new BadRequestException(
        'Không xác định được người dùng (gửi userId trong body hoặc Bearer token hợp lệ).',
      );
    }

    const data = checkoutData;
    const itemsRaw = Array.isArray(data.items) ? data.items : [];

    const items: any[] = [];
    for (const line of itemsRaw) {
      const pid = line.product;
      let productRef: Types.ObjectId | undefined;
      let productName = 'Sản phẩm';
      let variant = '—';
      let imageUrl = '';
      if (pid && Types.ObjectId.isValid(String(pid))) {
        productRef = new Types.ObjectId(String(pid));
        const prod = await this.productModel.findById(pid).lean();
        if (prod) {
          productName = (prod as any).name ?? productName;
          variant = this.specSummary(
            (prod as any).specifications as Record<string, unknown>,
          );
          const imgs = (prod as any).images;
          const rawImg =
            Array.isArray(imgs) && imgs.length ? String(imgs[0]) : '';
          imageUrl = this.absolutizeAssetUrl(rawImg);
        }
      }
      items.push({
        product: productRef,
        quantity: Number(line.quantity) || 1,
        price: Number(line.price) || 0,
        productName,
        variant,
        imageUrl,
      });
    }

    const newOrder = new this.orderModel({
      user: new Types.ObjectId(userId),
      items,
      totalAmount: Number(data.totalAmount) || 0,
      orderCode: this.makeOrderCode(),
      channel: data.channel === 'O2O' ? 'O2O' : 'ONLINE',
      status: 'PENDING_CONFIRMATION',
      // Nhớ lưu mã voucher và tiền giảm vào hóa đơn để sau này còn đối soát nhé sếp
      voucherCode: data.voucherCode || null,
      discountAmount: Number(data.discountAmount) || 0,
      shippingFee: Number(data.shippingFee) || 0,
      customerInfo: data.customerInfo || null,
    });
    console.log('🧾 [DEBUG checkout] voucherCode:', data.voucherCode, '| discountAmount:', data.discountAmount, '| shippingFee:', data.shippingFee);
    const savedOrder = await newOrder.save();

    const customer = await this.userModel
      .findById(userId)
      .select('fullName role')
      .lean();

    const customerName = customer?.fullName ?? 'Khách hàng';
    const payload = {
      orderCode: (savedOrder as any).orderCode || (savedOrder as any).code || 'N/A',
      totalPrice: (savedOrder as any).totalAmount || (savedOrder as any).totalPrice || 0,
      customerName:
        (savedOrder as any).customerName || (savedOrder as any).customer?.name || customerName || 'Khách hàng',
    };

    const paymentMethod = data.customerInfo?.paymentMethod || data.paymentMethod || 'COD';

    // Chỉ bắn thông báo ngay nếu là COD hoặc Mua tại quầy (O2O)
    // Các loại thanh toán Online (BANK_TRANSFER, VNPAY, MOMO) sẽ đợi Webhook xác nhận rồi mới bắn sau.
    const isOnlinePayment = ['BANK_TRANSFER', 'VNPAY', 'MOMO'].includes(paymentMethod);

    if (paymentMethod === 'COD' || data.channel === 'O2O' || !isOnlinePayment) {
      console.log('Emitting to admin-room...');
      this.notificationGateway.server.to('admin-room').emit('NEW_ORDER_RECEIVED', payload);
      console.log('Order event emitted for:', payload.orderCode);
    } else {
      console.log(`Skipping immediate notification. Payment method is ${paymentMethod}, waiting for webhook confirmation.`);
    }


    // 2. ✅ BƯỚC THẦN THÁNH: Tăng số lượng voucher đã dùng lên 1
    if (data.voucherCode) {
      try {
        await this.promotionModel.updateOne(
          { code: data.voucherCode }, // Tìm đúng mã voucher khách nhập
          { $inc: { usedCount: 1 } }, // Lệnh của MongoDB: Cộng 1 vào cột usedCount
        );
        console.log(`🚀 Đã cộng 1 lượt dùng cho mã: ${data.voucherCode}`);
      } catch (err) {
        console.error('Lỗi khi cập nhật số lượng voucher:', err);
      }
    }

    return savedOrder;
  }

  async emitOrderNotification(orderId: string) {
    try {
      const order = await this.orderModel.findById(orderId).populate('user', 'fullName').lean().exec();
      if (!order) return;
      const customerName = (order as any).user?.fullName || 'Khách hàng';
      const payload = {
        orderCode: (order as any).orderCode || 'N/A',
        totalPrice: order.totalAmount || 0,
        customerName: customerName,
      };
      this.notificationGateway.server.to('admin-room').emit('NEW_ORDER_RECEIVED', payload);
      console.log('Order event emitted for (from emitOrderNotification):', payload.orderCode);
    } catch (err) {
      console.error('Failed to emit order notification:', err);
    }
  }

  async findMyOrders(userId: string, statusFilter?: string) {
    if (!userId || !Types.ObjectId.isValid(userId)) {
      return { orders: [] };
    }

    const filter: Record<string, unknown> = {
      user: new Types.ObjectId(userId),
    };

    const sf = statusFilter?.trim().toUpperCase();
    if (
      sf &&
      ['PENDING_CONFIRMATION', 'PAID', 'SHIPPING', 'COMPLETED', 'CANCELLED'].includes(
        sf,
      )
    ) {
      if (sf === 'PENDING_CONFIRMATION') {
        filter.$or = [
          { status: 'PENDING_CONFIRMATION' },
          { status: 'PENDING' },
        ];
      } else {
        filter.status = sf;
      }
    }

    const rows = await this.orderModel
      .find(filter)
      .sort({ createdAt: -1 })
      .lean()
      .exec();

    return { orders: rows.map((doc) => this.mapOrderDoc(doc)) };
  }

  async findOrderByCode(orderCode: string) {
    return this.orderModel.findOne({ orderCode }).lean().exec();
  }

  /** Ghi nhận đã nhận thanh toán (QR/chuyển khoản) nhưng GIỮ NGUYÊN trạng thái workflow.
   *  Admin vẫn cần bấm "Xác nhận" để chuyển sang bước tiếp theo. */
  async markOrderAsPaid(orderId: string) {
    await this.orderModel.findByIdAndUpdate(orderId, {
      $set: { paidAt: new Date() },
    });
  }


  /** Đóng gói đơn hàng: Lưu Serial Number và chuyển sang SHIPPING. 
   *  Đồng thời ĐÁNH DẤU ProductItem là SOLD. */
  async packOrder(orderId: string, packData: { items: { productId: string, serialNumbers: string[] }[] }) {
    const order = await this.orderModel.findById(orderId);
    if (!order) throw new Error('Order not found');

    // 1. Cập nhật S/N vào đơn hàng
    for (const item of order.items) {
      const pData = packData.items.find(pd => String(pd.productId) === String(item.product));
      if (pData && pData.serialNumbers.length > 0) {
        item.serialNumbers = pData.serialNumbers;

        // 2. Cập nhật trạng thái ProductItem thành SOLD
        await this.productItemModel.updateMany(
          { serialNumber: { $in: pData.serialNumbers } },
          { $set: { status: 'Sold' } }
        );
      }
    }

    order.status = 'PACKING';
    const savedOrder = await order.save();

    // Gửi thông báo cho khách hàng (Nếu có user)
    if (savedOrder.user) {
      await this.notificationsService.createNotification({
        userId: savedOrder.user as any,
        title: 'Đơn hàng đã đóng gói 📦',
        message: `Đơn hàng #${savedOrder.orderCode || savedOrder._id} đã được đóng gói xong và đang chờ bàn giao cho đơn vị vận chuyển.`,
        orderId: savedOrder._id,
        type: 'ORDER_UPDATE',
      });
    }


    return savedOrder;
  }

  /** Tích hợp Giao Hàng Nhanh Sandbox API */
  async shipOrder(orderId: string, carrier: string) {
    console.log('--- [BACKEND] shipOrder START ---');
    console.log('--- [BACKEND] orderId:', orderId);
    console.log('--- [BACKEND] carrier:', carrier);
    
    let order;
    try {
      order = await this.orderModel.findById(orderId).populate('user');
      console.log('--- [BACKEND] Order found:', order?._id);
    } catch (e) {
      console.error('--- [BACKEND] findById ERROR:', e.message);
      throw new BadRequestException(`Lỗi truy vấn đơn hàng: ${e.message}`);
    }

    if (!order) throw new Error('Không tìm thấy đơn hàng');


    // Bây giờ hệ thống chỉ hỗ trợ duy nhất GHN
    try {
      // 1. Chuẩn bị dữ liệu gửi sang GHN (Payload chuẩn GHN)
      const ghnPayload = {
        from_name: "NetTech Shop",
        from_phone: "0909123456",
        from_address: "Phường Bến Nghé, Quận 1, TP. Hồ Chí Minh",
        from_district_id: 1442,
        from_ward_code: "20101",
        to_name: order.customerInfo?.fullName || 'Khách hàng NetTech',
        to_phone: order.customerInfo?.phone || '0900000000',
        to_address: order.customerInfo?.addressDetail || 'Phường Bến Nghé, Quận 1, TP. Hồ Chí Minh',
        to_district_id: 1442, // Giữ Quận 1 cho an toàn trong Demo
        to_ward_code: "20101", // Giữ Bến Nghé cho an toàn trong Demo
        weight: 1000,
        length: 20, width: 20, height: 10,
        service_id: 53320,
        payment_type_id: 2,
        required_note: "CHOXEMHANGKHONGTHU",
        items: order.items.map(it => ({
          name: it.productName,
          code: it.product ? it.product.toString() : 'N/A',
          quantity: it.quantity,
          price: it.price
        }))
      };

      // 2. Gọi API GHN Sandbox
      const response = await fetch('https://dev-online-gateway.ghn.vn/shiip/public-api/v2/shipping-order/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Token': process.env.GHN_TOKEN || '32e08ff7-4e85-11f1-a973-aee5264794df',
          'ShopId': process.env.GHN_SHOP_ID || '200288'
        },
        body: JSON.stringify(ghnPayload)
      });

      const result = await response.json();
      console.log('GHN API Full Response:', JSON.stringify(result, null, 2));

      if (result.code !== 200) {
        throw new Error(`Lỗi GHN: ${result.message || result.code_message || 'Lỗi không xác định'}`);
      }

      if (!result.data || !result.data.order_code) {
        throw new Error('GHN không trả về mã vận đơn trong data.');
      }

      const trackingNumber = result.data.order_code;

      // 3. Cập nhật thông tin giao hàng
      order.status = 'SHIPPING';
      order.shippingInfo = {
        carrier: 'Giao Hàng Nhanh (GHN)',
        trackingNumber,
        shippedAt: new Date()
      };

      await order.save();

      // 4. Thông báo khách hàng (Chỉ gửi nếu có user)
      if (order.user) {
        await this.notificationsService.createNotification({
          userId: order.user as any,
          title: 'Hàng đã được gửi đi!',
          message: `Đơn hàng #${order.orderCode} đã được bàn giao cho GHN. Mã vận đơn: ${trackingNumber}.`,
          type: 'ORDER_UPDATE',
        });
      }

      return { success: true, trackingNumber };

    } catch (error) {
      console.error('Ship Order Error:', error);
      throw new BadRequestException(error.message || 'Lỗi kết nối bưu cục');
    }
  }


  async completeOrder(orderId: string, force = false) {
    const order = await this.orderModel.findById(orderId).populate('user');
    if (!order) throw new BadRequestException('Không tìm thấy đơn hàng');

    if (order.status !== 'SHIPPING') {
      throw new BadRequestException('Chỉ có thể hoàn tất đơn hàng đang trong trạng thái giao hàng');
    }

    // Nếu không chọn "Ghi đè", thì mới đi hỏi GHN
    if (!force) {
      const trackingNumber = order.shippingInfo?.trackingNumber;
      if (!trackingNumber) {
        throw new BadRequestException('Đơn hàng chưa có mã vận đơn để đối soát');
      }

      try {
        const ghnResponse = await fetch('https://dev-online-gateway.ghn.vn/shiip/public-api/v2/shipping-order/detail', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Token': process.env.GHN_TOKEN || '32e08ff7-4e85-11f1-a973-aee5264794df'
          },
          body: JSON.stringify({ order_code: trackingNumber })
        });

        const ghnResult = await ghnResponse.json();
        console.log('GHN Status Check Response:', JSON.stringify(ghnResult, null, 2));

        if (ghnResult.code !== 200) {
          throw new Error(`Không thể lấy thông tin từ GHN: ${ghnResult.message}`);
        }

        const ghnStatus = ghnResult.data.status;
        const successStatuses = ['delivered', 'finish']; 

        if (!successStatuses.includes(ghnStatus.toLowerCase())) {
          throw new Error(`Đơn hàng chưa được giao hoàn tất (Trạng thái GHN: ${ghnStatus}). Bạn có muốn xác nhận thủ công không?`);
        }
      } catch (error) {
        throw new BadRequestException(error.message || 'Lỗi đối soát với bưu cục');
      }
    } else {
      console.log(`Order ${orderId} is being completed via FORCE override.`);
    }

    // 2. Hoàn tất đơn hàng
    order.status = 'COMPLETED';
    if (order.shippingInfo) {
      order.shippingInfo.deliveredAt = new Date();
    }
    
    await order.save();

    // Thông báo khách hàng
    if (order.user) {
      const uId = (order.user as any)._id || order.user;
      await this.notificationsService.createNotification({
        userId: uId,
        title: 'Đơn hàng hoàn tất! 🎉',
        message: `Đơn hàng #${order.orderCode} đã được giao thành công. Cảm ơn bạn đã mua sắm tại NetTech!`,
        orderId: (order as any)._id,
        type: 'ORDER_UPDATE',
      });

      // Gửi Real-time ting ting ngay lập tức
      this.notificationGateway.sendNotification(uId.toString(), {
        title: 'Đơn hàng hoàn tất! 🎉',
        message: `Đơn hàng #${order.orderCode} đã được giao thành công.`,
      });
    }

    return { success: true };
  }

  async handleGHNWebhook(payload: any) {
    const { OrderCode, Status } = payload;
    if (!OrderCode) return { success: false };

    const order = await this.orderModel.findOne({ 'shippingInfo.trackingNumber': OrderCode });
    if (!order) return { success: false };

    const successStatuses = ['delivered', 'finish'];
    if (successStatuses.includes(Status.toLowerCase()) && order.status !== 'COMPLETED') {
      order.status = 'COMPLETED';
      if (order.shippingInfo) {
        order.shippingInfo.deliveredAt = new Date();
      }
      await order.save();
      console.log(`Order ${order.orderCode} AUTO-COMPLETED via Webhook. Total revenue increased by ${order.totalAmount}`);

      // Thông báo khách hàng
      if (order.user) {
        const uId = (order.user as any)._id || order.user;
        await this.notificationsService.createNotification({
          userId: uId,
          title: 'Đơn hàng hoàn tất! 🎉',
          message: `Đơn hàng #${order.orderCode} đã được giao thành công. Cảm ơn bạn đã mua sắm tại NetTech!`,
          orderId: (order as any)._id,
          type: 'ORDER_UPDATE',
        });

        this.notificationGateway.sendNotification(uId.toString(), {
          title: 'Đơn hàng hoàn tất! 🎉',
          message: `Đơn hàng #${order.orderCode} đã được giao thành công.`,
        });
      }
    }

    return { success: true };
  }

  async syncAllOrdersWithGHN() {
    const shippingOrders = await this.orderModel.find({ status: 'SHIPPING' });
    let updatedCount = 0;

    for (const order of shippingOrders) {
      if (!order.shippingInfo?.trackingNumber) continue;

      try {
        const response = await fetch('https://dev-online-gateway.ghn.vn/shiip/public-api/v2/shipping-order/detail', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Token': process.env.GHN_TOKEN || '',
          },
          body: JSON.stringify({ order_code: order.shippingInfo.trackingNumber }),
        });

        const result = await response.json();
        if (result.code === 200) {
          const status = result.data.status.toLowerCase();
          if (['delivered', 'finish'].includes(status)) {
            order.status = 'COMPLETED';
            if (order.shippingInfo) order.shippingInfo.deliveredAt = new Date();
            await order.save();
            updatedCount++;
          }
        }
      } catch (e) {
        console.error(`Sync error for ${order.orderCode}:`, e);
      }
    }

    return { success: true, updatedCount };
  }

  async simulateGHNDelivery(orderId: string) {
    const order = await this.orderModel.findById(orderId);
    if (!order || !order.shippingInfo?.trackingNumber) return { success: false };

    // Trong thực tế, đây là nơi gọi API GHN Sandbox để "Simulate"
    // Ở đây mình sẽ giả lập bằng cách ép trạng thái trong DB mình luôn để sếp demo cho nhanh
    order.status = 'COMPLETED';
    if (order.shippingInfo) {
      order.shippingInfo.deliveredAt = new Date();
    }
    await order.save();
    return { success: true };
  }

  private mapOrderDoc(raw: any) {
    const codeRaw =
      raw.orderCode ||
      `LEGACY-${String(raw._id)
        .replace(/[^a-fA-F0-9]/g, '')
        .slice(-10)
        .toUpperCase()}`;
    const status =
      raw.status === 'PENDING' ? 'PENDING_CONFIRMATION' : raw.status;

    const items = (raw.items || []).map((it: any) => ({
      product: it.product ? String(it.product) : undefined,
      quantity: Number(it.quantity) || 1,
      price: Number(it.price) || 0,
      productName: it.productName || undefined,
      variant: it.variant || undefined,
      imageUrl: it.imageUrl || undefined,
      serialNumbers: it.serialNumbers || [],
    }));

    return {
      _id: String(raw._id),
      orderCode: codeRaw,
      createdAt: raw.createdAt,
      status,
      channel: raw.channel === 'O2O' ? 'O2O' : 'ONLINE',
      totalAmount: Number(raw.totalAmount) || 0,
      items,
      paidAt: raw.paidAt || null,
    };
  }

  // ─── Admin (Super Admin) — Quản lý đơn hàng ─────────────────────────────

  private escapeRegex(s: string) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** Nhãn ngày filter (theo giờ máy chủ local). */
  private resolveDateRange(preset: string | undefined): {
    start?: Date;
    end?: Date;
  } {
    if (!preset || preset === 'all') return {};
    const now = new Date();
    if (preset === 'today') {
      const s = new Date(now);
      s.setHours(0, 0, 0, 0);
      const e = new Date(now);
      e.setHours(23, 59, 59, 999);
      return { start: s, end: e };
    }
    if (preset === 'week') {
      const s = new Date(now);
      const day = s.getDay();
      const diff = s.getDate() - day + (day === 0 ? -6 : 1);
      s.setDate(diff);
      s.setHours(0, 0, 0, 0);
      const e = new Date(now);
      e.setHours(23, 59, 59, 999);
      return { start: s, end: e };
    }
    if (preset === 'month') {
      const s = new Date(now.getFullYear(), now.getMonth(), 1);
      const e = new Date(
        now.getFullYear(),
        now.getMonth() + 1,
        0,
        23,
        59,
        59,
        999,
      );
      return { start: s, end: e };
    }
    return {};
  }

  async getAdminStats(datePreset?: string) {
    const r = this.resolveDateRange(datePreset ?? 'all');
    const timeMatch =
      r.start && r.end ? { createdAt: { $gte: r.start, $lte: r.end } } : {};

    const [pendingOnline, packing, shipping, cancelled] = await Promise.all([
      this.orderModel.countDocuments({
        ...timeMatch,
        channel: 'ONLINE',
        $or: [{ status: 'PENDING_CONFIRMATION' }, { status: 'PENDING' }],
      }),
      this.orderModel.countDocuments({ ...timeMatch, status: 'PACKING' }),
      this.orderModel.countDocuments({ ...timeMatch, status: 'SHIPPING' }),
      this.orderModel.countDocuments({ ...timeMatch, status: 'CANCELLED' }),
    ]);

    return { pendingOnline, packing, shipping, cancelled };
  }

  async getAllOrders() {
    return this.findAdminOrders({});
  }

  async findAdminOrders(query: AdminOrdersQueryDto) {
    const tab = query.tab ?? 'all';
    const channel = query.channel ?? 'all';
    const datePreset = query.date ?? 'all';
    const qRaw = query.q?.trim();

    const and: Record<string, unknown>[] = [];
    const dr = this.resolveDateRange(datePreset);
    if (dr.start && dr.end) {
      and.push({ createdAt: { $gte: dr.start, $lte: dr.end } });
    }

    if (channel === 'ONLINE') and.push({ channel: 'ONLINE' });
    if (channel === 'O2O') and.push({ channel: 'O2O' });

    if (tab === 'pending') {
      and.push({
        $or: [{ status: 'PENDING_CONFIRMATION' }, { status: 'PENDING' }],
      });
    } else if (tab === 'processing') {
      and.push({ status: { $in: ['PACKING', 'SHIPPING'] } });
    } else if (tab === 'completed') {
      and.push({ status: 'COMPLETED' });
    }

    if (qRaw) {
      const esc = this.escapeRegex(qRaw);
      const users = await this.userModel
        .find({
          $or: [
            { phone: new RegExp(esc, 'i') },
            { email: new RegExp(esc, 'i') },
            { fullName: new RegExp(esc, 'i') },
          ],
          isDeleted: { $ne: true },
        })
        .select('_id')
        .lean()
        .exec();
      const uids = users.map((u) => u._id);
      and.push({
        $or: [{ orderCode: new RegExp(esc, 'i') }, { user: { $in: uids } }],
      });
    }

    const filter = and.length === 0 ? {} : { $and: and };

    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.max(1, Number(query.limit) || 10);
    const skip = (page - 1) * limit;

    const total = await this.orderModel.countDocuments(filter);
    const rows = await this.orderModel
      .find(filter)
      .populate('user', 'fullName phone email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean()
      .exec();

    const orders = await Promise.all(rows.map((doc) => this.mapAdminRow(doc)));
    return { orders, total, page, limit };
  }

  async getAdminOrdersPage(query: AdminOrdersQueryDto) {
    const dateForStats = query.date ?? 'all';
    const [stats, result] = await Promise.all([
      this.getAdminStats(dateForStats),
      this.findAdminOrders(query),
    ]);
    return { stats, orders: result.orders, total: result.total, page: result.page, limit: result.limit };
  }

  private async mapAdminRow(raw: any) {
    const u = raw.user as {
      fullName?: string;
      phone?: string;
      email?: string;
    } | null;
    const codeRaw =
      raw.orderCode ||
      `LEGACY-${String(raw._id)
        .replace(/[^a-fA-F0-9]/g, '')
        .slice(-10)
        .toUpperCase()}`;
    const code = codeRaw.startsWith('#') ? codeRaw : `#${codeRaw}`;
    let status = raw.status === 'PENDING' ? 'PENDING_CONFIRMATION' : raw.status;

    const items = await Promise.all((raw.items || []).map(async (it: any) => {
      // Lấy danh sách Serial đang AVAILABLE của sản phẩm này
      const availableItems = await this.productItemModel.find({
        productId: it.product,
        status: 'In Stock'
      }).select('serialNumber').lean();
      
      return {
        product: it.product ? String(it.product) : undefined,
        productName: it.productName || 'Sản phẩm',
        quantity: it.quantity || 1,
        variant: it.variant || '',
        price: it.price || 0,
        imageUrl: it.imageUrl || undefined,
        serialNumbers: it.serialNumbers || [],
        availableSerials: availableItems.map(ai => ai.serialNumber),
      };
    }));

    return {
      _id: String(raw._id),
      orderCode: code,
      createdAt: raw.createdAt,
      customerName:
        u?.fullName?.trim() || (raw.channel === 'O2O' ? 'Khách lẻ' : '—'),
      customerPhone: u?.phone?.trim() || u?.email?.trim() || '--',
      totalAmount: Number(raw.totalAmount) || 0,
      channel: raw.channel === 'O2O' ? 'O2O' : 'ONLINE',
      status,
      items,
      voucherCode: raw.voucherCode || null,
      discountAmount: Number(raw.discountAmount) || 0,
      shippingFee: Number(raw.shippingFee) || 0,
      shippingInfo: raw.shippingInfo || null,
      customerInfo: raw.customerInfo || null,
      paidAt: raw.paidAt || null,
    };
  }

  async updateOrderStatus(orderId: string, status: string) {
    if (!Types.ObjectId.isValid(orderId)) {
      throw new BadRequestException('Id đơn hàng không hợp lệ');
    }
    const allowed = new Set([
      'PENDING_CONFIRMATION',
      'PAID',
      'PACKING',
      'SHIPPING',
      'COMPLETED',
      'CANCELLED',
      'PENDING',
    ]);
    if (!allowed.has(status)) {
      throw new BadRequestException('Trạng thái không hợp lệ');
    }
    const updateData: any = { status };
    
    // Nếu chuyển sang CONFIRMED, lưu thêm thông tin ai xác nhận (tạm thời lấy staffId từ đâu đó nếu có)
    // Ở đây tôi sẽ viết một hàm confirmOrder riêng để xử lý chi tiết hơn bên dưới
    
    const doc = await this.orderModel
      .findByIdAndUpdate(orderId, updateData, { new: true })
      .populate('user', 'fullName phone email')
      .lean()
      .exec();
    if (!doc) {
      throw new NotFoundException('Không tìm thấy đơn hàng');
    }

    // Thông báo khách hàng khi thay đổi trạng thái
    if (doc.user) {
      const uId = (doc.user as any)._id || doc.user;
      let title = '';
      let message = '';

      switch (status) {
        case 'PACKING':
          title = 'Đơn hàng đang được đóng gói 📦';
          message = `Đơn hàng #${doc.orderCode} đang được nhân viên đóng gói cẩn thận.`;
          break;
        case 'SHIPPING':
          title = 'Đơn hàng đang được giao 🚚';
          message = `Đơn hàng #${doc.orderCode} đã được bàn giao cho đơn vị vận chuyển.`;
          break;
        case 'CANCELLED':
          title = 'Đơn hàng đã bị hủy ❌';
          message = `Đơn hàng #${doc.orderCode} của bạn đã bị hủy. Vui lòng liên hệ shop để biết thêm chi tiết.`;
          break;
      }

      if (title) {
        await this.notificationsService.createNotification({
          userId: uId,
          title,
          message,
          orderId: doc._id as any,
          type: 'ORDER_UPDATE',
        });

        const targetId = (doc.user as any)._id?.toString() || doc.user.toString();
        this.notificationGateway.sendNotification(targetId, { title, message });
      }
    }

    return await this.mapAdminRow(doc);
  }

  async confirmOrder(orderId: string, staffId: string) {
    if (!Types.ObjectId.isValid(orderId)) {
      throw new BadRequestException('Id đơn hàng không hợp lệ');
    }

    const order = await this.orderModel.findById(orderId).exec();
    if (!order) {
      throw new NotFoundException('Không tìm thấy đơn hàng');
    }

    if (order.status !== 'PENDING_CONFIRMATION' && order.status !== 'PENDING') {
      throw new BadRequestException('Đơn hàng này đã được xử lý hoặc không ở trạng thái chờ xác nhận');
    }

    // Cập nhật đơn hàng
    order.status = 'CONFIRMED';
    order.confirmedBy = new Types.ObjectId(staffId);
    order.confirmedAt = new Date();
    await order.save();

    // Gửi thông báo cho khách hàng
    if (order.user) {
      await this.notificationsService.createNotification({
        userId: order.user,
        orderId: order._id as any,
        title: 'Đơn hàng được xác nhận! ✅',
        message: `Đơn hàng #${order.orderCode} của bạn đã được xác nhận. Chúng tôi đang tiến hành chuẩn bị hàng cho bạn.`,
        type: 'ORDER_UPDATE',
      });

      this.notificationGateway.sendNotification(order.user.toString(), {
        title: 'Đơn hàng được xác nhận! ✅',
        message: `Đơn hàng #${order.orderCode} đã bắt đầu được xử lý.`,
      });
    }

    const populated = await this.orderModel.findById(orderId).populate('user', 'fullName phone email').lean().exec();
    return await this.mapAdminRow(populated);
  }

  async findOrderByCodeForUser(userId: string, orderCode: string) {
    const doc = await this.orderModel
      .findOne({ orderCode, user: new Types.ObjectId(userId) })
      .populate('user', 'fullName phone email')
      .lean()
      .exec();
    if (!doc) {
      throw new NotFoundException('Không tìm thấy đơn hàng');
    }
    return await this.mapAdminRow(doc);
  }

  async cancelOrderByUser(userId: string, orderId: string) {
    if (!Types.ObjectId.isValid(orderId)) {
      throw new BadRequestException('ID đơn hàng không hợp lệ');
    }

    const order = await this.orderModel.findOne({
      _id: new Types.ObjectId(orderId),
      user: new Types.ObjectId(userId),
    });

    if (!order) {
      throw new NotFoundException('Không tìm thấy đơn hàng');
    }

    if (order.status !== 'PENDING_CONFIRMATION' && order.status !== 'PENDING') {
      throw new BadRequestException(
        'Chỉ có thể hủy đơn hàng đang ở trạng thái chờ xác nhận',
      );
    }

    order.status = 'CANCELLED';
    await order.save();

    return { success: true };
  }
}
