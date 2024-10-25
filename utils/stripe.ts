"use server";

import prisma from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { auth, currentUser } from "@clerk/nextjs/server";

interface StripeSubscription {
  status: string;
  current_period_start: number;
  current_period_end: number;
  created: number;
}
//

export async function hasSubscription(): Promise<{
  isSubscribed: boolean;
  subscriptionData: StripeSubscription[];
}> {
  const { userId } = auth();
  const user = await currentUser();

  if (userId && user) {
    const userDB = await prisma.user.findUnique({
      where: {
      id: userId,
      },
    });

    if (!userDB?.stripe_customer_id) {
      return {
        isSubscribed: false,
        subscriptionData: [],
      };
    }

    const subscriptions = await stripe.subscriptions.list({
      customer: String(userDB.stripe_customer_id),
    });

    return {
      isSubscribed: subscriptions.data.length > 0,
      subscriptionData: subscriptions.data,
    };
  }

  return {
    isSubscribed: false,
    subscriptionData: [],
  };
}

export async function createCustomerIfNull(): Promise<string> {
  const user = await currentUser();
  if (!user) {
    throw new Error("User not authenticated");
  }

  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: { stripe_customer_id: true },
  });

  if (dbUser?.stripe_customer_id) {
    return dbUser.stripe_customer_id;
  }

  const customer = await stripe.customers.create({
    email: user.emailAddresses[0].emailAddress,
    name: `${user.firstName} ${user.lastName}`,
  });

  await prisma.user.update({
    where: { id: user.id },
    data: { stripe_customer_id: customer.id },
  });

  return customer.id;
}

export async function generateCustomerPortalLink(customerId: string | null) {
  if (!customerId) {
    throw new Error("Customer ID is required to generate portal link");
  }

  try {
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard`,
    });

    return portalSession.url;
  } catch (error) {
    console.error("Error generating customer portal link:", error);
    throw new Error("Failed to generate portal link: " + (error as Error).message);
  }
}

export async function createCheckoutLink(customerId: string | null) {
  if (!customerId) {
    throw new Error("Customer ID is required to create checkout link");
  }

  try {
    const checkout = await stripe.checkout.sessions.create({
      success_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/course`,
      customer: customerId,
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID,
          quantity: 1
        }
      ],
      mode: "subscription"
    });

    return checkout.url;
  } catch (error) {
    console.error("Error creating checkout link:", error);
    throw new Error("Failed to create checkout link: " + (error as Error).message);
  }
}

export async function checkLessonPlanCreationEligibility(): Promise<{
  isEligible: boolean;
  message: string;
  remainingGenerations: number;
}> {
  const { userId } = auth();
  const user = await currentUser();
  if (!userId || !user) {
    return {
      isEligible: false,
      message:
        "You must be logged in to see how many lesson plans you can make.",
      remainingGenerations: 0,
    };
  }

  const userDB = await prisma.user.findUnique({
    where: {
      id: userId,
    },
  });

  if (!userDB) {
    return {
      isEligible: false,
      message:
        "You must be logged in to see how many lesson plans you can make.",
      remainingGenerations: 0,
    };
  }

  const stripeSubscriptionData = await hasSubscription();

  const currentDate = new Date();

  let isSubscribed = false;
  let periodStart: Date;
  let periodEnd: Date;

  if (stripeSubscriptionData.subscriptionData.length > 0) {
    const subscription = stripeSubscriptionData.subscriptionData[0];
    isSubscribed = subscription.status === "active";
    periodStart = new Date(subscription.current_period_start * 1000);
    periodEnd = new Date(subscription.current_period_end * 1000);
  } else {
    periodEnd = currentDate;
    periodStart = new Date(currentDate.getTime() - 30 * 24 * 60 * 1000);
  }

  const lessonPlanGenerationCount = await prisma.lessonPlan.count({
    where: {
      userId: userDB.id,
      createdAt: {
        gte: periodStart,
        lte: periodEnd,
      },
    },
  });

  const limit = isSubscribed ? 30 : 10;
  const remainingGenerations = Math.max(0, limit - lessonPlanGenerationCount);

  if (remainingGenerations === 0) {
    const resetDate = isSubscribed
      ? periodEnd.toLocaleDateString()
      : new Date(
          currentDate.getTime() + 24 + 60 * 60 * 1000
        ).toLocaleDateString();

    return {
      isEligible: false,
      message: isSubscribed
        ? `You have reached the maximum number of lesson plans (30) for this subscription period. Reset Date: ${resetDate}`
        : `You have reached the maximum number of lesson plan generations (10) for the free tier. You can generate more starting ${resetDate}`,
      remainingGenerations: 0,
    };
  }

  return {
    isEligible: true,
    message: `You have ${remainingGenerations} lesson plan generation${
      remainingGenerations !== 1 ? "s" : ""
    } remaining for this ${isSubscribed ? "billing cycle" : "month"}`,
    remainingGenerations: remainingGenerations,
  };
}